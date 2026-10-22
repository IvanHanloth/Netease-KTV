import { PitchDetector } from 'pitchy'
import { hzToMidi } from './scoring'

export type MicError = 'insecure' | 'denied' | 'unavailable'

/** Microphone → AnalyserNode → pitchy. Call `read()` ~40×/s to get the singer's MIDI note. */
export class MicPitch {
  private stream: MediaStream | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private analyser: AnalyserNode | null = null
  private sink: GainNode | null = null
  private detector: PitchDetector<Float32Array> | null = null
  private buf: Float32Array<ArrayBuffer> | null = null
  private ctx: AudioContext | null = null

  get active() {
    return !!this.stream
  }

  async start(ctx: AudioContext): Promise<void> {
    if (this.stream) return
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      throw Object.assign(new Error('insecure'), { code: 'insecure' as MicError })
    }
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: false },
      })
    } catch (err) {
      const name = (err as DOMException)?.name
      const code: MicError = name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : 'unavailable'
      throw Object.assign(new Error(code), { code })
    }
    this.ctx = ctx
    this.stream = stream
    this.source = ctx.createMediaStreamSource(stream)
    this.analyser = ctx.createAnalyser()
    this.analyser.fftSize = 2048
    // Some browsers only process nodes that reach the destination; route through a muted gain.
    this.sink = ctx.createGain()
    this.sink.gain.value = 0
    this.source.connect(this.analyser)
    this.analyser.connect(this.sink)
    this.sink.connect(ctx.destination)
    this.detector = PitchDetector.forFloat32Array(this.analyser.fftSize)
    this.buf = new Float32Array(this.analyser.fftSize)
  }

  /** Current sung note as MIDI, or null when silent / unpitched. */
  read(): number | null {
    if (!this.analyser || !this.detector || !this.buf || !this.ctx) return null
    this.analyser.getFloatTimeDomainData(this.buf)
    let sq = 0
    for (let i = 0; i < this.buf.length; i++) sq += this.buf[i]! * this.buf[i]!
    if (Math.sqrt(sq / this.buf.length) < 0.01) return null
    const [hz, clarity] = this.detector.findPitch(this.buf, this.ctx.sampleRate)
    if (clarity < 0.85 || hz < 70 || hz > 1100) return null
    return hzToMidi(hz)
  }

  stop() {
    this.stream?.getTracks().forEach((t) => t.stop())
    this.source?.disconnect()
    this.analyser?.disconnect()
    this.sink?.disconnect()
    this.stream = null
    this.source = null
    this.analyser = null
    this.sink = null
    this.detector = null
    this.buf = null
  }
}
