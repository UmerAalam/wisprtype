export type Recording = {
  samples: Float32Array
  sampleRate: number
  durationSeconds: number
}

/**
 * Cheap gate for near-silent captures. Voz runs to its token limit on audio
 * with no speech in it, which costs tens of seconds and returns nothing.
 */
export function hasSpeech(samples: Float32Array, threshold = 0.02): boolean {
  for (let i = 0; i < samples.length; i += 32) {
    if (Math.abs(samples[i]) > threshold) return true
  }
  return false
}

/**
 * Captures raw mono PCM from the microphone. Raw samples keep the pipeline
 * simple: both Voz and Uhm accept Float32Array directly, with no container
 * decoding or temp files.
 */
export class MicRecorder {
  private context?: AudioContext
  private stream?: MediaStream
  private source?: MediaStreamAudioSourceNode
  private processor?: ScriptProcessorNode
  private analyser?: AnalyserNode
  private frequencyData?: Uint8Array<ArrayBuffer>
  private sink?: GainNode
  private chunks: Float32Array[] = []
  private length = 0
  private sampleRate = 16000

  async start(): Promise<void> {
    this.chunks = []
    this.length = 0

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    })

    try {
      this.context = new AudioContext({ sampleRate: 16000 })
    } catch {
      // Some webviews ignore a forced rate; both models accept any rate.
      this.context = new AudioContext()
    }
    this.sampleRate = this.context.sampleRate
    await this.context.resume()

    this.source = this.context.createMediaStreamSource(this.stream)
    this.analyser = this.context.createAnalyser()
    this.analyser.fftSize = 256
    this.analyser.smoothingTimeConstant = 0.75
    this.frequencyData = new Uint8Array(
      new ArrayBuffer(this.analyser.frequencyBinCount),
    )

    this.processor = this.context.createScriptProcessor(4096, 1, 1)
    this.processor.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0)
      this.chunks.push(new Float32Array(input))
      this.length += input.length
    }

    // A muted gain node keeps the processor running without playing audio.
    this.sink = this.context.createGain()
    this.sink.gain.value = 0
    this.source.connect(this.analyser)
    this.analyser.connect(this.processor)
    this.processor.connect(this.sink)
    this.sink.connect(this.context.destination)
  }

  /** Live frequency bands for the pill waveform, normalized to 0..1. */
  getLevels(count = 7): number[] {
    if (!this.analyser || !this.frequencyData) return Array(count).fill(0)
    this.analyser.getByteFrequencyData(this.frequencyData)

    // Speech energy is concentrated in the lower half of the spectrum.
    const usable = Math.floor(this.frequencyData.length * 0.6)
    const band = Math.max(1, Math.floor(usable / count))
    const levels: number[] = []
    for (let i = 0; i < count; i += 1) {
      let sum = 0
      for (let j = 0; j < band; j += 1) {
        sum += this.frequencyData[i * band + j] ?? 0
      }
      levels.push(Math.min(1, (sum / band / 255) * 1.8))
    }
    return levels
  }

  /** Copy what has been captured so far without stopping the microphone. */
  snapshot(): Recording {
    const samples = new Float32Array(this.length)
    let offset = 0
    for (const chunk of this.chunks) {
      samples.set(chunk, offset)
      offset += chunk.length
    }
    return {
      samples,
      sampleRate: this.sampleRate,
      durationSeconds: this.sampleRate ? this.length / this.sampleRate : 0,
    }
  }

  stop(): Recording {
    const samples = new Float32Array(this.length)
    let offset = 0
    for (const chunk of this.chunks) {
      samples.set(chunk, offset)
      offset += chunk.length
    }

    this.processor?.disconnect()
    this.analyser?.disconnect()
    this.source?.disconnect()
    this.sink?.disconnect()
    for (const track of this.stream?.getTracks() ?? []) track.stop()
    void this.context?.close()

    this.processor = undefined
    this.analyser = undefined
    this.frequencyData = undefined
    this.source = undefined
    this.sink = undefined
    this.stream = undefined
    this.context = undefined
    this.chunks = []

    return {
      samples,
      sampleRate: this.sampleRate,
      durationSeconds: this.sampleRate ? this.length / this.sampleRate : 0,
    }
  }
}
