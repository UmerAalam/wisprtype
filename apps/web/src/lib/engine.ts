import type { Recording } from "./audio"
import type {
  EngineJob,
  EngineReply,
  EngineRequest,
  EngineResult,
  Stage,
  Word,
} from "./engine-protocol"

export type { EngineResult, Stage, Word } from "./engine-protocol"

type Handlers = {
  onProgress?: (fraction: number) => void
  onStage?: (stage: Stage) => void
}

type Pending = Handlers & {
  resolve: (value: never) => void
  reject: (error: Error) => void
}

const pending = new Map<number, Pending>()
let nextId = 1
let worker: Worker | null = null

function route(reply: EngineReply) {
  const call = pending.get(reply.id)
  if (!call) return

  switch (reply.kind) {
    case "stage":
      call.onStage?.(reply.stage)
      return
    case "progress":
      call.onProgress?.(reply.fraction)
      return
    case "fail":
      pending.delete(reply.id)
      call.reject(new Error(reply.message))
      return
    case "ready":
      pending.delete(reply.id)
      call.resolve(undefined as never)
      return
    case "words":
      pending.delete(reply.id)
      call.resolve(reply.words as never)
      return
    case "result":
      pending.delete(reply.id)
      call.resolve(reply.result as never)
      return
  }
}

/**
 * The engine runs in a worker because a decode holds its thread for the whole
 * pass: on the main thread that froze the pill and swallowed the hotkey.
 */
function engine(): Worker {
  if (!worker) {
    worker = new Worker(new URL("./engine.worker.ts", import.meta.url), {
      type: "module",
    })
    worker.onmessage = (event: MessageEvent<EngineReply>) => route(event.data)
    worker.onerror = (event) => {
      failAll(event.message || "The transcription worker stopped")
    }
  }
  return worker
}

function failAll(message: string) {
  const error = new Error(message)
  for (const call of pending.values()) call.reject(error)
  pending.clear()
  worker?.terminate()
  worker = null
}

function request<T>(body: EngineJob, handlers: Handlers): Promise<T> {
  const id = nextId++
  return new Promise<T>((resolve, reject) => {
    pending.set(id, {
      ...handlers,
      resolve: resolve as (value: never) => void,
      reject,
    })
    engine().postMessage({ ...body, id } as EngineRequest)
  })
}

/**
 * Gives up on the pass in flight. The worker is replaced rather than left to
 * finish, and the models come back on their own so the next dictation does not
 * pay for a cold reload while the user is already talking.
 */
export function cancelEngine(reason = "Transcription cancelled") {
  if (pending.size === 0) return
  failAll(reason)
  void preloadEngine().catch(() => {})
}

export function preloadEngine(
  onProgress?: (fraction: number) => void,
  onStage?: (stage: Stage) => void,
): Promise<void> {
  return request<void>({ kind: "preload" }, { onProgress, onStage })
}

export function transcribeChunk(
  samples: Float32Array,
  sampleRate: number,
  onStage?: (stage: Stage) => void,
): Promise<Word[]> {
  return request<Word[]>({ kind: "chunk", samples, sampleRate }, { onStage })
}

export function transcribe(
  recording: Recording,
  onProgress?: (fraction: number) => void,
  onStage?: (stage: Stage) => void,
): Promise<EngineResult> {
  return request<EngineResult>(
    {
      kind: "full",
      samples: recording.samples,
      sampleRate: recording.sampleRate,
    },
    { onProgress, onStage },
  )
}
