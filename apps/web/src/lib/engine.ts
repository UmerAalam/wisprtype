import type { Recording } from "./audio"

export type Word = { text: string; start: number; end: number }

export type EngineResult = {
  text: string
  words: Word[]
  fillers: number
  fillerCleanupSkipped: boolean
}

type VozInstance = {
  transcribe: (
    audio: { samples: Float32Array; sampleRate: number },
  ) => Promise<{ text: string; words?: Word[] }>
}

type UhmInstance = {
  detect: (
    samples: Float32Array,
    sampleRate: number,
    options: { bias: "precision"; words: Word[] },
  ) => Promise<{ words?: Word[]; fillers?: unknown[] }>
  dispose?: () => void
}

let vozPromise: Promise<VozInstance> | null = null
let uhmPromise: Promise<UhmInstance> | null = null

/** Models are large; load each once and reuse the instance for every dictation. */
function getVoz(onProgress: (fraction: number) => void): Promise<VozInstance> {
  if (!vozPromise) {
    vozPromise = import("@desert-ant-labs/voz").then((module) =>
      module.Voz.load({ onProgress }),
    )
  }
  return vozPromise
}

function getUhm(): Promise<UhmInstance> {
  if (!uhmPromise) {
    uhmPromise = import("@desert-ant-labs/uhm").then(
      (module) => module.Uhm.load() as unknown as Promise<UhmInstance>,
    )
  }
  return uhmPromise!
}

export async function transcribe(
  recording: Recording,
  onProgress?: (fraction: number) => void,
): Promise<EngineResult> {
  const voz = await getVoz(onProgress ?? (() => {}))
  const result = await voz.transcribe({
    samples: recording.samples,
    sampleRate: recording.sampleRate,
  })
  const words: Word[] = result.words ?? []

  let cleanedWords = words
  let fillers = 0
  let fillerCleanupSkipped = false

  try {
    const uhm = await getUhm()
    const detected = await uhm.detect(recording.samples, recording.sampleRate, {
      bias: "precision",
      words,
    })
    if (Array.isArray(detected.words) && detected.words.length > 0) {
      cleanedWords = detected.words
    }
    fillers = detected.fillers?.length ?? 0
  } catch (error) {
    // A failed filler pass must never lose the transcript.
    fillerCleanupSkipped = true
    console.warn("Uhm filler cleanup was skipped:", error)
  }

  const text = (
    cleanedWords.length > 0
      ? cleanedWords.map((word) => word.text).join(" ")
      : result.text
  ).trim()

  return { text, words: cleanedWords, fillers, fillerCleanupSkipped }
}
