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
import { transcribe } from "../lib/engine"

export const Route = createFileRoute("/")({ component: WisprBar })

type Phase = "ready" | "recording" | "thinking" | "done" | "error"

const BAR_LABEL: Record<Phase, string> = {
  ready: "Ready when you are",
  recording: "Listening...",
  thinking: "Transcribing on device",
  done: "Typed into your field",
  error: "Something went wrong",
}

function WisprBar() {
  const [phase, setPhase] = useState<Phase>("ready")
  const [message, setMessage] = useState(
    "Press Alt + W anywhere, then speak",
  )
  const [transcript, setTranscript] = useState("")
  const [progress, setProgress] = useState(0)
  const phaseRef = useRef<Phase>("ready")
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
      setMessage(
        result.text.length === 0
          ? "No speech detected"
          : result.fillerCleanupSkipped
            ? "Typed in (filler cleanup skipped)"
            : "Typed in, fillers removed",
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
    <main className="stage">
      <div className={`pill ${phase}`}>
        <button
          type="button"
          className="orb"
          onClick={() => toggleRef.current()}
          disabled={busy}
          aria-label={phase === "recording" ? "Stop dictation" : "Start dictation"}
        >
          {phase === "recording" ? (
            <span className="wave" aria-hidden="true">
              {[0, 1, 2, 3, 4].map((bar) => (
                <i key={bar} style={{ animationDelay: `${bar * 90}ms` }} />
              ))}
            </span>
          ) : busy ? (
            <span className="spinner" aria-hidden="true" />
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

        <div className="copy">
          <span className="title">
            {BAR_LABEL[phase]}
            {phase === "recording" && <span className="live-dot" />}
          </span>
          <span className="status">{message}</span>
          {phase === "thinking" && progress > 0 && progress < 1 && (
            <span className="track">
              <i style={{ width: `${Math.round(progress * 100)}%` }} />
            </span>
          )}
          {phase === "done" && transcript && (
            <button
              type="button"
              className="copy-link"
              onClick={() => void copyText(transcript)}
            >
              Copy transcript
            </button>
          )}
        </div>

        <kbd className="shortcut">Alt + W</kbd>
      </div>
    </main>
  )
}
