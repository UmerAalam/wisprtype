import type { Recording } from "./audio"

export type Word = {
  text: string
  start: number
  end: number
  speaker?: number
}

export type EngineResult = {
  text: string
  words: Word[]
  fillers: number
  fillerCleanupSkipped: boolean
  speakerCount: number
  speakerDiarizationSkipped: boolean
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

type WhoTurn = { speaker: number; start: number; end: number }

type WhoInstance = {
  diarize: (
    input: { samples: Float32Array; sampleRate: number },
  ) => Promise<{ speakerCount: number; turns: WhoTurn[] }>
  dispose?: () => void
}

let vozPromise: Promise<VozInstance> | null = null
let uhmPromise: Promise<UhmInstance> | null = null
let whoPromise: Promise<WhoInstance> | null = null

/** Models are large; load each once and reuse the instance for every dictation. */
function getVoz(onProgress: (fraction: number) => void): Promise<VozInstance> {
  if (!vozPromise) {
    vozPromise = import("@desert-ant-labs/voz")
      .then((module) => module.Voz.load({ onProgress }))
      .catch((error) => {
        vozPromise = null
        throw error
      })
  }
  return vozPromise
}

function getUhm(): Promise<UhmInstance> {
  if (!uhmPromise) {
    uhmPromise = import("@desert-ant-labs/uhm")
      .then((module) => module.Uhm.load() as unknown as Promise<UhmInstance>)
      .catch((error) => {
        uhmPromise = null
        throw error
      })
  }
  return uhmPromise!
}

function getWho(onProgress: (fraction: number) => void): Promise<WhoInstance> {
  if (!whoPromise) {
    whoPromise = import("@desert-ant-labs/who")
      .then(
        (module) =>
          module.Who.load({
            accelerator: "auto",
            onProgress,
          }) as unknown as Promise<WhoInstance>,
      )
      .catch((error) => {
        whoPromise = null
        throw error
      })
  }
  return whoPromise
}

/**
 * Warms all three models at launch so later dictations do not wait on loading.
 * Voz dominates the download, so its progress carries most of the bar.
 */
export async function preloadEngine(
  onProgress?: (fraction: number) => void,
): Promise<void> {
  let vozProgress = 0
  let whoProgress = 0
  const report = () => onProgress?.(vozProgress * 0.85 + whoProgress * 0.15)

  await Promise.all([
    getVoz((fraction) => {
      vozProgress = fraction
      report()
    }),
    getUhm(),
    getWho((fraction) => {
      whoProgress = fraction
      report()
    }),
  ])
}

function labelSpeakers(words: Word[], turns: WhoTurn[]): Word[] {
  return words.map((word) => {
    const midpoint = (word.start + word.end) / 2
    const turn = turns.find(
      (candidate) => midpoint >= candidate.start && midpoint <= candidate.end,
    )
    return turn ? { ...word, speaker: turn.speaker } : word
  })
}

function formatBySpeaker(words: Word[]): string {
  const lines: string[] = []
  let currentSpeaker: number | undefined
  let currentWords: string[] = []

  const flush = () => {
    if (currentWords.length === 0) return
    lines.push(
      `Speaker ${(currentSpeaker ?? 0) + 1}: ${currentWords.join(" ")}`,
    )
  }

  for (const word of words) {
    const speaker = word.speaker ?? 0
    if (speaker !== currentSpeaker) {
      flush()
      currentSpeaker = speaker
      currentWords = []
    }
    currentWords.push(word.text)
  }
  flush()

  return lines.join("\n")
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

  let speakerCount = 1
  let speakerDiarizationSkipped = false
  let labeledWords = cleanedWords

  try {
    const who = await getWho(() => {})
    const diarization = await who.diarize({
      samples: recording.samples,
      sampleRate: recording.sampleRate,
    })
    speakerCount = diarization.speakerCount || 1
    if (speakerCount > 1) {
      labeledWords = labelSpeakers(cleanedWords, diarization.turns)
    }
  } catch (error) {
    speakerDiarizationSkipped = true
    console.warn("Who speaker labeling was skipped:", error)
  }

  const plainText = (
    labeledWords.length > 0
      ? labeledWords.map((word) => word.text).join(" ")
      : result.text
  ).trim()

  const text =
    speakerCount > 1 && !speakerDiarizationSkipped && labeledWords.length > 0
      ? formatBySpeaker(labeledWords)
      : plainText

  return {
    text,
    words: labeledWords,
    fillers,
    fillerCleanupSkipped,
    speakerCount,
    speakerDiarizationSkipped,
  }
}
