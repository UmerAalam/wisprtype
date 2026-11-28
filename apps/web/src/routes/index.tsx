import { createFileRoute } from "@tanstack/react-router"
import {
  ChevronDown,
  Hand,
  Keyboard,
  LoaderCircle,
  Mic,
  NotebookPen,
  Radio,
  X,
} from "lucide-react"
import { AnimatePresence, motion, type Variants } from "motion/react"
import { useEffect, useRef, useState, type CSSProperties } from "react"

import { hasSpeech, MicRecorder } from "../lib/audio"
import {
  copyText,
  hideBar,
  insertText,
  isDesktop,
  onHoldKey,
  onToggle,
  showBar,
} from "../lib/desktop"
import {
  cancelEngine,
  preloadEngine,
  transcribe,
  transcribeChunk,
  type Stage,
  type Word,
} from "../lib/engine"

export const Route = createFileRoute("/")({ component: WisprBar })

type Phase =
  "warming" | "ready" | "recording" | "live" | "thinking" | "done" | "error"
type Mode = "notes" | "live"
type Trigger = "hotkey" | "hold"

const TRIGGER_HINT: Record<Trigger, string> = {
  hotkey: "Alt + W",
  hold: "Right Ctrl",
}

const READY_NOTE: Record<Trigger, string> = {
  hotkey: "Press Alt + W anywhere, then speak",
  hold: "Hold Right Ctrl, speak, then let go",
}

const BAR_LABEL: Record<Phase, string> = {
  warming: "Warming up models",
  ready: "Ready when you are",
  recording: "",
  live: "",
  thinking: "Transcribing",
  done: "Typed into your field",
  error: "Something went wrong",
}

const STAGE_LABEL: Record<Stage, string> = {
  model: "Loading model",
  decode: "Decoding",
  fillers: "Removing fillers",
  speakers: "Labeling speakers",
  extras: "Loading cleanup models",
}

const IDLE_ORB = "#3590f3"
const STOP_RED = "#ff002b"

const pillVariant: Variants = {
  open: {
    opacity: 1,
    y: 0,
    scale: 1,
    transition: { type: "spring", stiffness: 400, damping: 30, mass: 0.8 },
  },
  closed: {
    opacity: 0,
    y: 14,
    scale: 0.96,
    transition: { duration: 0.18, ease: "easeIn" },
  },
}

// Labels only, never inline objects: the pill re-renders many times a second
// while the mic is open, and a fresh object identity restarts the gesture.
const panelVariant: Variants = {
  open: {
    opacity: 1,
    y: 0,
    transition: { type: "spring", stiffness: 400, damping: 32, mass: 0.8 },
  },
  closed: {
    opacity: 0,
    y: 10,
    transition: { duration: 0.16, ease: "easeIn" },
  },
}

const panelFill: CSSProperties = { backgroundColor: "rgba(13,24,31,0.92)" }

const closeVariant: Variants = {
  open: {
    opacity: 1,
    scale: 1,
    transition: { type: "spring", stiffness: 480, damping: 24, delay: 0.09 },
  },
  closed: {
    opacity: 0,
    scale: 0.4,
    transition: { duration: 0.15, ease: "easeIn" },
  },
  hover: { scale: 1.07 },
  tapped: { scale: 0.93 },
}

const orbFill: CSSProperties = { backgroundColor: IDLE_ORB }
const closeFill: CSSProperties = { backgroundColor: STOP_RED }

function WisprBar() {
  const [phase, setPhase] = useState<Phase>("warming")
  const [message, setMessage] = useState(
    "Loading Voz locally. First launch downloads 390 MB.",
  )
  const [transcript, setTranscript] = useState("")
  const [progress, setProgress] = useState(0)
  const [mode, setMode] = useState<Mode>("notes")
  const [trigger, setTrigger] = useState<Trigger>("hotkey")
  const [stage, setStage] = useState<Stage | null>(null)
  const [stageSeconds, setStageSeconds] = useState(0)
  const [levels, setLevels] = useState<number[]>(() => Array(7).fill(0))
  // The native window only exists while shown, so the bar mounts on demand and
  // AnimatePresence can run its exit before hide_bar tears the window down.
  const [barOpen, setBarOpen] = useState(() => !isDesktop())
  const phaseRef = useRef<Phase>("warming")
  const modeRef = useRef<Mode>("notes")
  const triggerRef = useRef<Trigger>("hotkey")
  const holdRef = useRef<(down: boolean) => void>(() => {})
  const stopAfterStartRef = useRef(false)
  const recorderRef = useRef<MicRecorder | null>(null)
  const toggleRef = useRef<() => void>(() => {})
  const liveTimerRef = useRef<number | null>(null)
  const liveBusyRef = useRef(false)
  const liveEndRef = useRef(0)
  const liveTextRef = useRef("")
  const stageStartRef = useRef(0)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const cancelledRef = useRef(false)

  function setCurrentPhase(next: Phase, note?: string) {
    phaseRef.current = next
    setPhase(next)
    if (note) setMessage(note)
  }

  function chooseMode(next: Mode) {
    modeRef.current = next
    setMode(next)
  }

  function chooseTrigger(next: Trigger) {
    triggerRef.current = next
    setTrigger(next)
  }

  function enterStage(next: Stage) {
    stageStartRef.current = Date.now()
    setStage(next)
    setStageSeconds(0)
  }

  function stopLiveTimer() {
    if (liveTimerRef.current !== null) {
      window.clearInterval(liveTimerRef.current)
      liveTimerRef.current = null
    }
  }

  async function typeFreshWords(words: Word[], offset = 0) {
    if (words.length === 0) return
    const chunk = words
      .map((word) => word.text)
      .join(" ")
      .trim()
    if (!chunk) return

    const prefix = liveTextRef.current ? " " : ""
    await insertText(prefix + chunk)
    liveTextRef.current += prefix + chunk
    setTranscript(liveTextRef.current)
    liveEndRef.current = Math.max(...words.map((word) => word.end + offset))

    // insertText hides the window to return focus to the target field.
    // Re-show it without taking focus so the live indicator stays visible.
    window.setTimeout(() => {
      void showBar(false)
    }, 300)
  }

  /** Decodes only what has not been typed yet, starting `offset` seconds in. */
  async function typeTail(
    samples: Float32Array,
    sampleRate: number,
    durationSeconds: number,
    minTail = 2,
  ) {
    const offset = Math.max(0, liveEndRef.current - 0.75)
    if (durationSeconds < offset + minTail || liveBusyRef.current) return

    liveBusyRef.current = true
    try {
      const words = await transcribeChunk(
        samples.subarray(Math.floor(offset * sampleRate)),
        sampleRate,
        enterStage,
      )
      const fresh = words.filter(
        (word) => word.start + offset >= liveEndRef.current - 0.08,
      )
      await typeFreshWords(fresh, offset)
    } catch (error) {
      console.warn("Live transcription chunk failed:", error)
    } finally {
      liveBusyRef.current = false
    }
  }

  async function insertLiveChunk() {
    const recorder = recorderRef.current
    if (!recorder) return
    const snapshot = recorder.snapshot()
    await typeTail(
      snapshot.samples,
      snapshot.sampleRate,
      snapshot.durationSeconds,
    )
  }

  async function start() {
    const selected = modeRef.current
    cancelledRef.current = false
    stopAfterStartRef.current = false
    setCurrentPhase(selected === "live" ? "live" : "recording")
    setMessage("")
    setTranscript("")
    setProgress(0)
    if (selected === "live") {
      liveEndRef.current = 0
      liveTextRef.current = ""
      liveBusyRef.current = false
    }
    await showBar()
    setBarOpen(true)

    try {
      const recorder = new MicRecorder()
      await recorder.start()
      recorderRef.current = recorder

      // Released before the microphone opened: finish the tap as soon as it can.
      if (stopAfterStartRef.current) {
        stopAfterStartRef.current = false
        await finish()
        return
      }

      if (selected === "live") {
        liveTimerRef.current = window.setInterval(() => {
          void insertLiveChunk()
        }, 3000)
      }
    } catch {
      setCurrentPhase(
        "error",
        "Microphone blocked. Allow mic access and try again.",
      )
    }
  }

  async function finish() {
    const recorder = recorderRef.current
    if (!recorder) return
    stopLiveTimer()

    if (modeRef.current === "live") {
      const recording = recorder.stop()
      recorderRef.current = null
      await typeTail(
        recording.samples,
        recording.sampleRate,
        recording.durationSeconds,
        0.6,
      )
      setCurrentPhase("done", "Live mode stopped")
      window.setTimeout(() => {
        setBarOpen(false)
        setCurrentPhase("ready", READY_NOTE[triggerRef.current])
      }, 1400)
      return
    }

    setCurrentPhase("thinking", "Transcribing on device")
    const recording = recorder.stop()
    recorderRef.current = null

    if (!hasSpeech(recording.samples)) {
      setTranscript("")
      setCurrentPhase("done", "No speech detected")
      window.setTimeout(() => {
        setBarOpen(false)
        setCurrentPhase("ready", READY_NOTE[triggerRef.current])
      }, 1400)
      return
    }

    try {
      const result = await transcribe(recording, setProgress, enterStage)
      setTranscript(result.text)
      const seconds = Math.round(
        Object.values(result.timings).reduce((sum, ms) => sum + (ms ?? 0), 0) /
          1000,
      )
      const notes: string[] = []
      if (!result.fillerCleanupSkipped) notes.push("fillers removed")
      if (result.speakerCount > 1 && !result.speakerDiarizationSkipped) {
        notes.push(`${result.speakerCount} speakers labeled`)
      }
      if (seconds > 1) notes.push(`took ${seconds}s`)
      setMessage(
        result.text.length === 0
          ? "No speech detected"
          : notes.length > 0
            ? `Typed in, ${notes.join(", ")}`
            : "Typed in",
      )
      setCurrentPhase("done")
      await insertText(result.text)

      window.setTimeout(() => {
        setBarOpen(false)
        setCurrentPhase("ready", READY_NOTE[triggerRef.current])
      }, 1600)
    } catch (error) {
      if (cancelledRef.current) {
        cancelledRef.current = false
        return
      }
      const detail = error instanceof Error ? error.message : String(error)
      setCurrentPhase("error", detail.slice(0, 140) || "Transcription failed")
    }
  }

  /** Hides the bar without typing. Stops capture first so the mic is not left open behind a hidden window. */
  async function dismissBar() {
    stopLiveTimer()
    if (recorderRef.current) {
      recorderRef.current.stop()
      recorderRef.current = null
    }
    setBarOpen(false)
    setCurrentPhase("ready", READY_NOTE[triggerRef.current])
  }

  /** Drops a decode that has run too long so the bar is never left waiting. */
  function cancelThinking() {
    cancelledRef.current = true
    cancelEngine()
    setBarOpen(false)
    setCurrentPhase(
      "ready",
      `Cancelled. ${TRIGGER_HINT[triggerRef.current]} to try again`,
    )
  }

  async function toggle() {
    if (phaseRef.current === "recording" || phaseRef.current === "live") {
      await finish()
    } else if (phaseRef.current === "thinking") {
      cancelThinking()
    } else {
      await start()
    }
  }

  // Assign on every render so the global shortcut always sees current state.
  toggleRef.current = () => {
    void toggle()
  }

  // Hold to talk: record while Right Ctrl is down, transcribe on release.
  holdRef.current = (down) => {
    if (triggerRef.current !== "hold") return
    const current = phaseRef.current

    if (down) {
      if (current === "ready" || current === "warming" || current === "error") {
        void start()
      }
      return
    }

    if (current === "recording" || current === "live") {
      if (recorderRef.current) void finish()
      else stopAfterStartRef.current = true
    }
  }

  useEffect(() => {
    let disposed = false
    let stopListening: (() => void) | undefined
    let stopHold: (() => void) | undefined

    void onToggle(() => toggleRef.current()).then((stop) => {
      if (disposed) stop()
      else stopListening = stop
    })

    void onHoldKey((down) => holdRef.current(down)).then((stop) => {
      if (disposed) stop()
      else stopHold = stop
    })

    void preloadEngine(setProgress, enterStage)
      .then(() => {
        if (!disposed && phaseRef.current === "warming") {
          setCurrentPhase("ready", READY_NOTE[triggerRef.current])
        }
      })
      .catch(() => {
        if (!disposed && phaseRef.current === "warming") {
          setCurrentPhase("ready", "Models will load on first dictation")
        }
      })

    if (!isDesktop()) {
      setMessage("Browser preview: click the orb to record")
    }

    return () => {
      disposed = true
      stopListening?.()
      stopHold?.()
      stopLiveTimer()
      recorderRef.current?.stop()
    }
  }, [])

  const busy = phase === "thinking"
  const listening = phase === "recording" || phase === "live"
  const locked = listening || busy
  const stageNote =
    (busy || phase === "warming") && stage
      ? `${STAGE_LABEL[stage]} · ${stageSeconds}s`
      : null

  useEffect(() => {
    if (!busy && phase !== "warming") return
    const id = window.setInterval(() => {
      setStageSeconds(Math.round((Date.now() - stageStartRef.current) / 1000))
    }, 1000)
    return () => window.clearInterval(id)
  }, [busy, phase])

  useEffect(() => {
    if (!listening) {
      setLevels(Array(7).fill(0))
      return
    }
    let frame = 0
    const tick = () => {
      setLevels(recorderRef.current?.getLevels(7) ?? Array(7).fill(0))
      frame = window.requestAnimationFrame(tick)
    }
    frame = window.requestAnimationFrame(tick)
    return () => window.cancelAnimationFrame(frame)
  }, [listening])

  useEffect(() => {
    const panel = panelRef.current
    if (panel) panel.scrollTop = panel.scrollHeight
  }, [transcript])

  return (
    <main className="flex h-screen w-screen flex-col items-center justify-center gap-2 bg-transparent p-3">
      <AnimatePresence>
        {barOpen && (transcript || listening || busy) && (
          <motion.div
            key="wispr-text"
            variants={panelVariant}
            initial="closed"
            animate="open"
            exit="closed"
            style={panelFill}
            className="w-full max-w-[380px] rounded-box border border-base-300/30 p-2 backdrop-blur-xl"
          >
            <div className="mb-1 text-[10px] uppercase tracking-wide opacity-50">
              {busy
                ? "Transcribing"
                : transcript
                  ? "Heard"
                  : listening
                    ? "Listening"
                    : ""}
            </div>
            <div
              ref={panelRef}
              className="max-h-24 min-h-6 overflow-y-auto whitespace-pre-wrap text-sm leading-snug"
            >
              {transcript}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="flex w-full items-center justify-center gap-3">
        <AnimatePresence onExitComplete={() => void hideBar()}>
          {barOpen && (
            <motion.div
              key="wispr-pill"
              variants={pillVariant}
              initial="closed"
              animate="open"
              exit="closed"
              className={`card !flex-row !rounded-full w-full max-w-[380px] items-center gap-2 border bg-[linear-gradient(135deg,rgba(23,38,47,0.94),rgba(13,24,31,0.96))] p-2 shadow-none backdrop-blur-xl ${
                listening
                  ? "border-2 border-error/70"
                  : phase === "thinking"
                    ? "border-2 border-primary/50"
                    : "border border-base-300/30"
              }`}
            >
              <button
                type="button"
                className={`btn btn-circle btn-sm shrink-0 ${
                  listening ? "btn-error" : "text-white"
                }`}
                style={listening ? undefined : orbFill}
                onClick={() => toggleRef.current()}
                disabled={busy}
                aria-label={
                  phase === "recording"
                    ? "Stop dictation"
                    : phase === "live"
                      ? "Stop live mode"
                      : "Start dictation"
                }
              >
                {listening ? (
                  <span
                    className="loading loading-dots loading-xs"
                    aria-hidden="true"
                  />
                ) : busy ? (
                  <LoaderCircle
                    className="animate-spin"
                    size={16}
                    aria-hidden="true"
                  />
                ) : (
                  <Mic size={17} strokeWidth={2.1} aria-hidden="true" />
                )}
              </button>

              <div className="min-w-0 flex-1">
                {listening ? (
                  <div className="flex h-5 items-center gap-2">
                    <span
                      className="inline-block h-2 w-2 animate-pulse rounded-full bg-error"
                      aria-label="Listening"
                    />
                    <div
                      className="flex h-5 items-end gap-0.5"
                      aria-hidden="true"
                    >
                      {levels.map((level, index) => (
                        <span
                          key={index}
                          className="w-1 rounded-full bg-error/80 transition-[height] duration-75"
                          style={{
                            height: `${Math.max(3, Math.round(level * 20))}px`,
                          }}
                        />
                      ))}
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="text-sm font-semibold">
                      {BAR_LABEL[phase]}
                    </div>
                    <div className="truncate text-xs opacity-60">
                      {stageNote ?? message}
                    </div>
                  </>
                )}
                {(phase === "warming" || phase === "thinking") &&
                  progress > 0 &&
                  progress < 1 && (
                    <progress
                      className="progress progress-primary mt-1 h-1 w-full"
                      value={progress}
                      max={1}
                    />
                  )}
                {phase === "done" && transcript && (
                  <button
                    type="button"
                    className="btn btn-ghost btn-xs mt-1 h-auto min-h-0 px-0 text-primary"
                    onClick={() => void copyText(transcript)}
                  >
                    Copy transcript
                  </button>
                )}
              </div>

              <div className="dropdown dropdown-end dropdown-top shrink-0">
                <div
                  tabIndex={0}
                  role="button"
                  className="btn btn-ghost btn-xs gap-1 px-1.5"
                  aria-label="Choose dictation mode"
                >
                  {mode === "notes" ? (
                    <NotebookPen
                      size={13}
                      strokeWidth={2.2}
                      aria-hidden="true"
                    />
                  ) : (
                    <Radio size={13} strokeWidth={2.2} aria-hidden="true" />
                  )}
                  {mode === "notes" ? "Notes" : "Live"}
                  <ChevronDown
                    size={13}
                    className="opacity-60"
                    aria-hidden="true"
                  />
                </div>
                <ul
                  tabIndex={0}
                  className="dropdown-content menu menu-sm z-50 w-44 rounded-box bg-base-200 p-1 shadow"
                >
                  <li>
                    <button
                      type="button"
                      className={mode === "notes" ? "active" : ""}
                      disabled={locked}
                      onClick={() => chooseMode("notes")}
                    >
                      <NotebookPen size={15} aria-hidden="true" />
                      <span className="flex flex-col items-start">
                        <span>Recording</span>
                        <span className="text-[10px] opacity-60">
                          for notetaking
                        </span>
                      </span>
                    </button>
                  </li>
                  <li>
                    <button
                      type="button"
                      className={mode === "live" ? "active" : ""}
                      disabled={locked}
                      onClick={() => chooseMode("live")}
                    >
                      <Radio size={15} aria-hidden="true" />
                      <span className="flex flex-col items-start">
                        <span>Live mode</span>
                        <span className="text-[10px] opacity-60">
                          types as you speak
                        </span>
                      </span>
                    </button>
                  </li>
                  <li className="menu-title mt-1 px-2 text-[10px] opacity-60">
                    Trigger
                  </li>
                  <li>
                    <button
                      type="button"
                      className={trigger === "hotkey" ? "active" : ""}
                      disabled={locked}
                      onClick={() => chooseTrigger("hotkey")}
                    >
                      <Keyboard size={15} aria-hidden="true" />
                      <span className="flex flex-col items-start">
                        <span>Hands free</span>
                        <span className="text-[10px] opacity-60">
                          Alt + W starts and stops
                        </span>
                      </span>
                    </button>
                  </li>
                  <li>
                    <button
                      type="button"
                      className={trigger === "hold" ? "active" : ""}
                      disabled={locked}
                      onClick={() => chooseTrigger("hold")}
                    >
                      <Hand size={15} aria-hidden="true" />
                      <span className="flex flex-col items-start">
                        <span>Hold to talk</span>
                        <span className="text-[10px] opacity-60">
                          keep Right Ctrl held
                        </span>
                      </span>
                    </button>
                  </li>
                </ul>
              </div>

              <kbd className="kbd kbd-xs shrink-0">{TRIGGER_HINT[trigger]}</kbd>
            </motion.div>
          )}

          {barOpen && (
            <motion.button
              key="wispr-close"
              type="button"
              className="grid size-11 shrink-0 place-items-center rounded-full text-white disabled:opacity-40"
              style={closeFill}
              variants={closeVariant}
              initial="closed"
              animate="open"
              exit="closed"
              whileHover="hover"
              whileTap="tapped"
              onClick={() => (busy ? cancelThinking() : void dismissBar())}
              aria-label={busy ? "Cancel transcription" : "Close bar"}
            >
              <X size={18} strokeWidth={2.3} aria-hidden="true" />
            </motion.button>
          )}
        </AnimatePresence>
      </div>
    </main>
  )
}
