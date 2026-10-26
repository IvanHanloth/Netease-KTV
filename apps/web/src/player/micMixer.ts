/**
 * 主屏 microphones: one or more input devices mixed, cleaned up and reverberated, then played
 * through the speakers together with the song (and offered as a stream for 耳返 phones).
 *
 *   mic A ─ gain ┐
 *   mic B ─ gain ┼─ bus ─ high-pass ─ compressor ─┬─ dry ──────────────────────────┐
 *                │   (scoring taps the bus)        └─ pre-delay ─ convolver ─ tone ─ wet ┴─ fx ─┬─ level ─ limiter ─ speakers
 *                                                                                              └─ 耳返 stream
 *
 * It runs in its own AudioContext with the lowest latency the device offers: the song engine uses
 * a 'playback' context (big buffers, glitch-free), which would add an audible delay to a live voice.
 */
import type { MicError } from './mic'

export interface MicInputInfo {
  deviceId: string
  label: string
  groupId: string
}

/** '' = the system default input. */
export const DEFAULT_MIC = ''

/** Level slider (0..1) → gain; 0.7 is unity, 1 is about +6 dB. */
export const micGain = (v: number) => 2 * v * v
/** Reverb amount (0..1) → wet gain. */
const wetGain = (r: number) => 1.1 * r
/** The dry voice dips a little as the reverb grows, so the overall level stays about the same. */
const dryGain = (r: number) => 1 - 0.3 * r

interface Input {
  stream: MediaStream
  source: MediaStreamAudioSourceNode
  gain: GainNode
  analyser: AnalyserNode
}

/**
 * A hall-like impulse response: a few early reflections, then decorrelated stereo noise with an
 * exponential decay that also darkens over time (high frequencies die out first, like a real room).
 */
function makeImpulse(ctx: BaseAudioContext, seconds = 2.4): AudioBuffer {
  const rate = ctx.sampleRate
  const len = Math.floor(rate * seconds)
  const buf = ctx.createBuffer(2, len, rate)
  const early = [
    [0.011, 0.5],
    [0.019, -0.36],
    [0.027, 0.3],
    [0.037, -0.24],
    [0.049, 0.18],
  ] as const
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch)
    let lp = 0
    for (let i = 0; i < len; i++) {
      const t = i / rate
      const env = Math.exp((-6.9 * t) / (seconds * 0.85)) // −60 dB a little before the end
      const a = Math.min(0.92, 0.25 + 0.3 * t) // one-pole low-pass, darker as the tail goes on
      lp = a * lp + (1 - a) * (Math.random() * 2 - 1)
      d[i] = lp * env * (i < rate * 0.004 ? i / (rate * 0.004) : 1)
    }
    // Early reflections, mirrored and slightly offset between the channels for width.
    for (const [at, amp] of early) {
      const k = Math.floor((at + ch * 0.0017) * rate)
      if (k < len) d[k] = (d[k] ?? 0) + amp * (ch ? -1 : 1)
    }
  }
  return buf
}

export class MicMixer {
  ctx: AudioContext | null = null
  private inputs = new Map<string, Input>()
  private opening = new Map<string, Promise<void>>()
  private bus!: GainNode
  private dry!: GainNode
  private wet!: GainNode
  private fx!: GainNode
  private level!: GainNode
  private streamOut!: MediaStreamAudioDestinationNode
  private levelValue = 0.7
  private reverbValue = 0.3
  private deviceGains: Record<string, number> = {}
  /** The devices the latest setDevices() asked for. */
  private wanted: string[] = []
  private resumeOnGesture: (() => void) | null = null

  get running() {
    return !!this.ctx
  }

  /** Sum of the microphones before any effect (pitch detection reads it). */
  get tap(): { ctx: AudioContext; node: AudioNode } | null {
    return this.ctx ? { ctx: this.ctx, node: this.bus } : null
  }

  /** The processed microphone mix (with reverb, before the speaker level), for 耳返 phones. */
  get stream(): MediaStream | null {
    return this.ctx ? this.streamOut.stream : null
  }

  get openIds(): string[] {
    return [...this.inputs.keys()]
  }

  private build() {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    const ctx = new Ctx({ latencyHint: 'interactive' })
    this.ctx = ctx
    this.bus = ctx.createGain()
    // Handling noise, breath pops and room rumble.
    const hp = ctx.createBiquadFilter()
    hp.type = 'highpass'
    hp.frequency.value = 95
    hp.Q.value = 0.7
    // Gentle vocal compression: quiet lines come forward, shouts don't jump out.
    const comp = ctx.createDynamicsCompressor()
    comp.threshold.value = -26
    comp.knee.value = 12
    comp.ratio.value = 3
    comp.attack.value = 0.004
    comp.release.value = 0.18
    this.dry = ctx.createGain()
    const preDelay = ctx.createDelay(0.2)
    preDelay.delayTime.value = 0.028
    const conv = ctx.createConvolver()
    conv.buffer = makeImpulse(ctx)
    const tone = ctx.createBiquadFilter()
    tone.type = 'lowpass'
    tone.frequency.value = 6500
    this.wet = ctx.createGain()
    this.fx = ctx.createGain()
    this.level = ctx.createGain()
    // Safety limiter: a howl or a dropped mic is loud, never harsh digital clipping.
    const limiter = ctx.createDynamicsCompressor()
    limiter.threshold.value = -3
    limiter.knee.value = 0
    limiter.ratio.value = 20
    limiter.attack.value = 0.001
    limiter.release.value = 0.1
    this.streamOut = ctx.createMediaStreamDestination()

    this.bus.connect(hp).connect(comp)
    comp.connect(this.dry).connect(this.fx)
    comp.connect(preDelay).connect(conv).connect(tone).connect(this.wet).connect(this.fx)
    this.fx.connect(this.level).connect(limiter).connect(ctx.destination)
    this.fx.connect(this.streamOut)
    this.applyLevels(0)
  }

  private applyLevels(tc = 0.06) {
    const ctx = this.ctx
    if (!ctx) return
    const now = ctx.currentTime
    const set = (p: AudioParam, v: number) => (tc ? p.setTargetAtTime(v, now, tc) : p.setValueAtTime(v, now))
    set(this.level.gain, micGain(this.levelValue))
    set(this.dry.gain, dryGain(this.reverbValue))
    set(this.wet.gain, wetGain(this.reverbValue))
    for (const [id, inp] of this.inputs) set(inp.gain.gain, this.deviceGains[id] ?? 1)
  }

  setLevel(v: number) {
    this.levelValue = v
    this.applyLevels()
  }

  setReverb(r: number) {
    this.reverbValue = r
    this.applyLevels()
  }

  /** Per-device balance (0..2, 1 = as is), e.g. two singers on two microphones. */
  setDeviceGains(g: Record<string, number>) {
    this.deviceGains = g
    this.applyLevels()
  }

  /**
   * Open exactly these inputs (closing the others). Resolves with the devices that failed and why;
   * the ones that opened keep playing.
   */
  async setDevices(ids: string[]): Promise<Map<string, MicError>> {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      return new Map(ids.map((id) => [id, 'insecure' as MicError]))
    }
    if (!this.ctx) this.build()
    this.wanted = ids
    for (const id of [...this.inputs.keys()]) if (!ids.includes(id)) this.close(id)
    const errors = new Map<string, MicError>()
    await Promise.all(
      ids.map(async (id) => {
        if (this.inputs.has(id)) return
        try {
          await this.open(id)
        } catch (err) {
          errors.set(id, (err as { code?: MicError }).code ?? 'unavailable')
        }
      }),
    )
    // A newer call may have dropped some of these while they were opening.
    for (const id of [...this.inputs.keys()]) if (!this.wanted.includes(id)) this.close(id)
    await this.ensureRunning()
    return errors
  }

  private open(id: string): Promise<void> {
    const pending = this.opening.get(id)
    if (pending) return pending
    const p = (async () => {
      let stream: MediaStream
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            ...(id ? { deviceId: { exact: id } } : {}),
            // A live voice: no phone-call processing (it would pump and cut the singing), and
            // the smallest capture buffer the device allows.
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
            latency: { ideal: 0 },
          } as MediaTrackConstraints,
        })
      } catch (err) {
        const name = (err as DOMException)?.name
        const code: MicError = name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : 'unavailable'
        throw Object.assign(new Error(code), { code })
      }
      const ctx = this.ctx
      if (!ctx || !this.wanted.includes(id)) {
        stream.getTracks().forEach((t) => t.stop())
        return
      }
      const source = ctx.createMediaStreamSource(stream)
      const gain = ctx.createGain()
      gain.gain.value = this.deviceGains[id] ?? 1
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 512
      source.connect(gain).connect(this.bus)
      source.connect(analyser)
      this.inputs.set(id, { stream, source, gain, analyser })
      // Unplugged: forget it so the list and meters show it is gone.
      stream.getAudioTracks()[0]?.addEventListener('ended', () => {
        if (this.inputs.get(id)?.stream === stream) this.close(id)
      })
    })()
    this.opening.set(id, p)
    p.finally(() => this.opening.delete(id)).catch(() => {})
    return p
  }

  private close(id: string) {
    const inp = this.inputs.get(id)
    if (!inp) return
    this.inputs.delete(id)
    inp.stream.getTracks().forEach((t) => t.stop())
    inp.source.disconnect()
    inp.gain.disconnect()
    inp.analyser.disconnect()
  }

  /** A context made outside a click may start suspended: resume now, or on the next interaction. */
  private async ensureRunning() {
    const ctx = this.ctx
    if (!ctx || ctx.state === 'running') return
    try {
      await ctx.resume()
    } catch {
      /* needs a gesture */
    }
    // (re-read: resume() changed it)
    if ((ctx.state as AudioContextState) === 'running' || this.resumeOnGesture) return
    const resume = () => {
      void ctx.resume().catch(() => {})
      window.removeEventListener('pointerdown', resume)
      window.removeEventListener('keydown', resume)
      this.resumeOnGesture = null
    }
    this.resumeOnGesture = resume
    window.addEventListener('pointerdown', resume)
    window.addEventListener('keydown', resume)
  }

  /** Input level per open device (RMS, 0..1), for the meters. */
  levels(): Map<string, number> {
    const out = new Map<string, number>()
    const buf = new Float32Array(512)
    for (const [id, inp] of this.inputs) {
      inp.analyser.getFloatTimeDomainData(buf)
      let sq = 0
      for (let i = 0; i < buf.length; i++) sq += buf[i]! * buf[i]!
      out.set(id, Math.sqrt(sq / buf.length))
    }
    return out
  }

  stop() {
    this.wanted = []
    for (const id of [...this.inputs.keys()]) this.close(id)
    if (this.resumeOnGesture) {
      window.removeEventListener('pointerdown', this.resumeOnGesture)
      window.removeEventListener('keydown', this.resumeOnGesture)
      this.resumeOnGesture = null
    }
    const ctx = this.ctx
    this.ctx = null
    if (ctx) void ctx.close().catch(() => {})
  }
}

/** Audio inputs the browser can see. Labels are empty until microphone access has been granted once. */
export async function listMics(): Promise<MicInputInfo[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return []
  try {
    const all = await navigator.mediaDevices.enumerateDevices()
    return (
      all
        .filter((d) => d.kind === 'audioinput' && d.deviceId)
        // Chrome's "default" / "communications" entries repeat a real device: the 系统默认 row covers them.
        .filter((d) => d.deviceId !== 'default' && d.deviceId !== 'communications')
        .map((d) => ({ deviceId: d.deviceId, label: d.label, groupId: d.groupId }))
    )
  } catch {
    return []
  }
}
