/// <reference lib="webworker" />
import type {
  EngineReply,
  EngineRequest,
  EngineResult,
  Stage,
  Word,
} from "./engine-protocol"

/** A post-processing model that never settles must not hold the transcript. */
const STAGE_TIMEOUT_MS = 20_000

const ctx = self as unknown as Worker & {
  onmessage: ((event: MessageEvent<EngineRequest>) => void) | null
}

function post(reply: EngineReply) {
  ctx.postMessage(reply)
}

function withTimeout<T>(stage: Stage, work: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${stage} timed out after ${STAGE_TIMEOUT_MS / 1000}s`))
    }, STAGE_TIMEOUT_MS)
    work.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

type VozInstance = {
  transcribe: (
    audio: { samples: Float32Array; sampleRate: number },
    options?: { onProgress?: (fraction: number) => void },
  ) => Promise<{
    text: string
    words?: Word[]
    duration?: number
    processingTime?: number
    realtimeFactor?: number
  }>
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
  diarize: (input: {
    samples: Float32Array
    sampleRate: number
  }) => Promise<{ speakerCount: number; turns: WhoTurn[] }>
  dispose?: () => void
}

let vozPromise: Promise<VozInstance> | null = null
let uhmPromise: Promise<UhmInstance> | null = null
let whoPromise: Promise<WhoInstance> | null = null

/** Models are large; load each once and reuse the instance for every dictation. */
function getVoz(
  onProgress: (fraction: number) => void,
  onStage?: (stage: Stage) => void,
): Promise<VozInstance> {
  if (!vozPromise) {
    onStage?.("model")
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
  return uhmPromise
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

async function runPreload(id: number) {
  post({ kind: "stage", id, stage: "model" })
  const voz = await getVoz(
    (fraction) => post({ kind: "progress", id, fraction }),
    (stage) => post({ kind: "stage", id, stage }),
  )
  void voz
  post({ kind: "progress", id, fraction: 1 })
  post({ kind: "stage", id, stage: "extras" })
  // Uhm and Who only post-process, so a slow download must not delay readiness.
  void Promise.allSettled([getUhm(), getWho(() => {})])
  post({ kind: "ready", id })
}

/** Fast Voz-only pass for live mode, where latency matters more than cleanup. */
async function runChunk(id: number, samples: Float32Array, sampleRate: number) {
  post({ kind: "stage", id, stage: "model" })
  const voz = await getVoz(
    () => {},
    (stage) => post({ kind: "stage", id, stage }),
  )
  post({ kind: "stage", id, stage: "decode" })
  const result = await voz.transcribe(
    { samples, sampleRate },
    { onProgress: (fraction) => post({ kind: "progress", id, fraction }) },
  )
  post({ kind: "words", id, words: result.words ?? [] })
}

async function runFull(id: number, samples: Float32Array, sampleRate: number) {
  const timings: Partial<Record<Stage, number>> = {}
  const stage = (next: Stage) => post({ kind: "stage", id, stage: next })

  const modelStart = Date.now()
  stage("model")
  const voz = await getVoz(
    (fraction) => post({ kind: "progress", id, fraction }),
    stage,
  )
  timings.model = Date.now() - modelStart

  const decodeStart = Date.now()
  stage("decode")
  const result = await voz.transcribe(
    { samples, sampleRate },
    { onProgress: (fraction) => post({ kind: "progress", id, fraction }) },
  )
  timings.decode = Date.now() - decodeStart
  const words: Word[] = result.words ?? []
  const audioSeconds = result.duration ?? samples.length / sampleRate
  const realtimeFactor =
    result.realtimeFactor ??
    (audioSeconds > 0 ? timings.decode! / 1000 / audioSeconds : 0)

  let cleanedWords = words
  let fillers = 0
  let fillerCleanupSkipped = false

  const fillerStart = Date.now()
  stage("fillers")
  try {
    const uhm = await withTimeout("fillers", getUhm())
    const detected = await withTimeout(
      "fillers",
      uhm.detect(samples, sampleRate, { bias: "precision", words }),
    )
    if (Array.isArray(detected.words) && detected.words.length > 0) {
      cleanedWords = detected.words
    }
    fillers = detected.fillers?.length ?? 0
  } catch (error) {
    // A failed filler pass must never lose the transcript.
    fillerCleanupSkipped = true
    console.warn("Uhm filler cleanup was skipped:", error)
  } finally {
    timings.fillers = Date.now() - fillerStart
  }

  const speakerStart = Date.now()
  stage("speakers")
  let speakerCount = 1
  let speakerDiarizationSkipped = false
  let labeledWords = cleanedWords

  try {
    const who = await withTimeout(
      "speakers",
      getWho(() => {}),
    )
    const diarization = await withTimeout(
      "speakers",
      who.diarize({ samples, sampleRate }),
    )
    speakerCount = diarization.speakerCount || 1
    if (speakerCount > 1) {
      labeledWords = labelSpeakers(cleanedWords, diarization.turns)
    }
  } catch (error) {
    speakerDiarizationSkipped = true
    console.warn("Who speaker labeling was skipped:", error)
  } finally {
    timings.speakers = Date.now() - speakerStart
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

  const payload: EngineResult = {
    text,
    words: labeledWords,
    fillers,
    fillerCleanupSkipped,
    speakerCount,
    speakerDiarizationSkipped,
    timings,
    realtimeFactor,
  }
  post({ kind: "result", id, result: payload })
}

/**
 * ONNX holds one device and a lot of memory per instance, so decodes run one at
 * a time even though the client only ever awaits a single request.
 */
let queue: Promise<void> = Promise.resolve()

ctx.onmessage = (event) => {
  const request = event.data
  const run =
    request.kind === "preload"
      ? () => runPreload(request.id)
      : request.kind === "chunk"
        ? () => runChunk(request.id, request.samples, request.sampleRate)
        : () => runFull(request.id, request.samples, request.sampleRate)

  queue = queue.then(run, run).catch((error: unknown) => {
    const detail = error instanceof Error ? error.message : String(error)
    post({ kind: "fail", id: request.id, message: detail || "Engine failed" })
  })
}
