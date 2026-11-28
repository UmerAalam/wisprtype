export type Word = {
  text: string
  start: number
  end: number
  speaker?: number
}

/** Pipeline phases, reported as they start so the bar can name what it waits on. */
export type Stage = "model" | "decode" | "fillers" | "speakers" | "extras"

export type EngineResult = {
  text: string
  words: Word[]
  fillers: number
  fillerCleanupSkipped: boolean
  speakerCount: number
  speakerDiarizationSkipped: boolean
  /** Seconds spent per stage, measured in the worker. */
  timings: Partial<Record<Stage, number>>
  /** Seconds of wall clock per second of audio for the Voz pass. */
  realtimeFactor: number
}

export type EngineJob =
  | { kind: "preload" }
  | { kind: "chunk"; samples: Float32Array; sampleRate: number }
  | { kind: "full"; samples: Float32Array; sampleRate: number }

export type EngineRequest = EngineJob & { id: number }

export type EngineReply =
  | { kind: "stage"; id: number; stage: Stage }
  | { kind: "progress"; id: number; fraction: number }
  | { kind: "ready"; id: number }
  | { kind: "words"; id: number; words: Word[] }
  | { kind: "result"; id: number; result: EngineResult }
  | { kind: "fail"; id: number; message: string }
