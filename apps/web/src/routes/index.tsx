import { createFileRoute } from "@tanstack/react-router"
import { useEffect, useRef, useState } from "react"

import { MicRecorder } from "../lib/audio"
import {
  copyText,
  hideBar,
  insertText,
  isDesktop,
  onToggle,
  showBar,
} from "../lib/desktop"
import { preloadEngine, transcribe } from "../lib/engine"

export const Route = createFileRoute("/")({ component: WisprBar })

type Phase = "warming" | "ready" | "recording" | "thinking" | "done" | "error"

const BAR_LABEL: Record<Phase, string> = {
  warming: "Warming up models",
  ready: "Ready when you are",
  recording: "Listening...",
  thinking: "Transcribing on device",
  done: "Typed into your field",
  error: "Something went wrong",
}

function WisprBar() {
  const [phase, setPhase] = useState<Phase>("warming")
  const [message, setMessage] = useState(
    "Loading Voz and Uhm locally. First launch may take a minute.",
  )
  const [transcript, setTranscript] = useState("")
  const [progress, setProgress] = useState(0)
  const phaseRef = useRef<Phase>("warming")
  const recorderRef = useRef<MicRecorder | null>(null)
  const toggleRef = useRef<() => void>(() => {})

  function setCurrentPhase(next: Phase, note?: string) {
    phaseRef.current = next
    setPhase(next)
    if (note) setMessage(note)
  }

  async function start() {
    setCurrentPhase("recording", "Listening... press Alt + W to finish")
    setTranscript("")
    setProgress(0)
    await showBar()

    try {
      const recorder = new MicRecorder()
      await recorder.start()
      recorderRef.current = recorder
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

    setCurrentPhase("thinking", "Loading model / transcribing on device")
    const recording = recorder.stop()
    recorderRef.current = null

    try {
      const result = await transcribe(recording, setProgress)
      setTranscript(result.text)
      const notes: string[] = []
      if (!result.fillerCleanupSkipped) notes.push("fillers removed")
      if (result.speakerCount > 1 && !result.speakerDiarizationSkipped) {
        notes.push(`${result.speakerCount} speakers labeled`)
      }
      setMessage(
        result.text.length === 0
          ? "No speech detected"
          : notes.length > 0
            ? `Typed in, ${notes.join(" and ")}`
            : "Typed in",
      )
      setCurrentPhase("done")
      await insertText(result.text)

      window.setTimeout(async () => {
        await hideBar()
        setCurrentPhase("ready", "Press Alt + W anywhere, then speak")
      }, 1600)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      setCurrentPhase("error", detail.slice(0, 140) || "Transcription failed")
    }
  }

  async function toggle() {
    if (phaseRef.current === "recording") {
      await finish()
    } else if (phaseRef.current === "thinking") {
      return
    } else {
      await start()
    }
  }

  // Assign on every render so the global shortcut always sees current state.
  toggleRef.current = () => {
    void toggle()
  }

  useEffect(() => {
    let disposed = false
    let stopListening: (() => void) | undefined

    void onToggle(() => toggleRef.current()).then((stop) => {
      if (disposed) stop()
      else stopListening = stop
    })

    void preloadEngine(setProgress)
      .then(() => {
        if (!disposed && phaseRef.current === "warming") {
          setCurrentPhase("ready", "Press Alt + W anywhere, then speak")
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
      recorderRef.current?.stop()
    }
  }, [])

  const busy = phase === "thinking"

  return (
    <main className="flex h-screen w-screen items-center justify-center bg-transparent p-3">
      <div
        className={`card !flex-row !rounded-full w-full max-w-[460px] items-center gap-3 border bg-transparent p-2 shadow-none ${
          phase === "recording"
            ? "border-error/50"
            : phase === "thinking"
              ? "border-primary/40"
              : "border-base-300/30"
        }`}
      >
        <button
          type="button"
          className={`btn btn-circle btn-sm shrink-0 ${
            phase === "recording" ? "btn-error" : "btn-primary"
          }`}
          onClick={() => toggleRef.current()}
          disabled={busy}
          aria-label={phase === "recording" ? "Stop dictation" : "Start dictation"}
        >
          {phase === "recording" ? (
            <span className="loading loading-dots loading-xs" aria-hidden="true" />
          ) : busy ? (
            <span className="loading loading-spinner loading-xs" aria-hidden="true" />
          ) : (
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
              <path
                d="M12 15.2a3.6 3.6 0 0 0 3.6-3.6V6.1a3.6 3.6 0 1 0-7.2 0v5.5A3.6 3.6 0 0 0 12 15.2Zm6-5.5a6 6 0 0 1-12 0M12 18.3v2.4"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
              />
            </svg>
          )}
        </button>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <span>{BAR_LABEL[phase]}</span>
            {phase === "recording" && (
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-error" />
            )}
          </div>
          <div className="truncate text-xs opacity-60">{message}</div>
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

        <kbd className="kbd kbd-xs shrink-0">Alt + W</kbd>
      </div>
    </main>
  )
}
