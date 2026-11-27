export type Recording = {
  samples: Float32Array
  sampleRate: number
  durationSeconds: number
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
    this.processor = this.context.createScriptProcessor(4096, 1, 1)
    this.processor.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0)
      this.chunks.push(new Float32Array(input))
      this.length += input.length
    }

    // A muted gain node keeps the processor running without playing audio.
    this.sink = this.context.createGain()
    this.sink.gain.value = 0
    this.source.connect(this.processor)
    this.processor.connect(this.sink)
    this.sink.connect(this.context.destination)
  }

  stop(): Recording {
    const samples = new Float32Array(this.length)
    let offset = 0
    for (const chunk of this.chunks) {
      samples.set(chunk, offset)
      offset += chunk.length
    }

    this.processor?.disconnect()
    this.source?.disconnect()
    this.sink?.disconnect()
    for (const track of this.stream?.getTracks() ?? []) track.stop()
    void this.context?.close()

    this.processor = undefined
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
