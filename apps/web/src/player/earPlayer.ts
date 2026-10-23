/**
 * 移动耳返 audio: plays one stem (vocals / original / accompaniment) on the phone, in step with the TV.
 *
 * The caller passes a target function: buffer position that should be *heard* at a given
 * performance.now() time. start() schedules the source on the audio clock so that holds from the
 * first sample on; afterwards heard() reports where the phone really is, and small drift is pulled
 * in with tiny playback-rate changes (±0.4 %, inaudible) instead of audible jumps.
 */
import { outputTimeMap } from './engine'

/** Decoded buffers kept: the current stem plus one more (mode switch / next song). */
const CACHE_SIZE = 2

export class EarPlayer {
  ctx: AudioContext | null = null
  private out: GainNode | null = null
  private src: AudioBufferSourceNode | null = null
  private srcGain: GainNode | null = null
  buffer: AudioBuffer | null = null
  bufferUrl = ''
  private anchorCtx = 0
  private anchorPos = 0
  private rate = 1
  private cache = new Map<string, Promise<AudioBuffer>>()

  async unlock() {
    if (!this.ctx) {
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      // Interactive = the lowest output latency the phone offers: this is a monitor.
      this.ctx = new Ctx({ latencyHint: 'interactive' })
      this.out = this.ctx.createGain()
      this.out.connect(this.ctx.destination)
    }
    if (this.ctx.state !== 'running') await this.ctx.resume()
  }

  get playing() {
    return !!this.src
  }

  get currentRate() {
    return this.rate
  }

  load(url: string): Promise<AudioBuffer> {
    const hit = this.cache.get(url)
    if (hit) {
      this.cache.delete(url)
      this.cache.set(url, hit)
      return hit
    }
    const p = (async () => {
      const res = await fetch(url)
      if (!res.ok) throw new Error(`音频加载失败（${res.status}）`)
      const data = await res.arrayBuffer()
      if (!this.ctx) throw new Error('AudioContext 未初始化')
      return await this.ctx.decodeAudioData(data)
    })()
    this.cache.set(url, p)
    p.catch(() => this.cache.delete(url))
    while (this.cache.size > CACHE_SIZE) this.cache.delete(this.cache.keys().next().value as string)
    return p
  }

  /** Switch to another decoded buffer (stops the current one). */
  setBuffer(buffer: AudioBuffer | null, url: string) {
    if (buffer === this.buffer) return
    this.stop(0.05)
    this.buffer = buffer
    this.bufferUrl = buffer ? url : ''
  }

  setVolume(v: number) {
    if (!this.ctx || !this.out) return
    this.out.gain.setTargetAtTime(Math.max(0, Math.min(1.5, v)), this.ctx.currentTime, 0.05)
  }

  /**
   * A short beep (1 kHz, 60 ms) at audio-clock time `at`, through the same output as the monitor
   * audio, so a latency measured with it applies to the monitor. Used by the 蓝牙延迟 calibration.
   * Returns a function that drops the beep (silences it if it is sounding, or has not started yet).
   */
  beep(at: number): () => void {
    const ctx = this.ctx
    if (!ctx) return () => {}
    const osc = ctx.createOscillator()
    osc.frequency.value = 1000
    const g = ctx.createGain()
    g.gain.setValueAtTime(0, at)
    g.gain.linearRampToValueAtTime(0.5, at + 0.004)
    g.gain.setValueAtTime(0.5, at + 0.045)
    g.gain.linearRampToValueAtTime(0, at + 0.06)
    osc.connect(g).connect(ctx.destination)
    osc.start(at)
    osc.stop(at + 0.07)
    let done = false
    const end = () => {
      if (done) return
      done = true
      osc.disconnect()
      g.disconnect()
    }
    osc.onended = end
    return () => {
      if (done) return
      g.gain.cancelScheduledValues(ctx.currentTime)
      g.gain.setValueAtTime(0, ctx.currentTime)
      try {
        osc.stop()
      } catch {
        /* already stopped */
      }
      end()
    }
  }

  /** Audio-clock time whose sample comes out of the phone at performance.now() time `perf`. */
  ctxOf(perf: number): number {
    const m = outputTimeMap(this.ctx!)
    return m.ctxTime + (perf - m.perf) / 1000
  }

  /** performance.now() time at which audio-clock time `c` comes out of the phone. */
  perfOf(c: number): number {
    const m = outputTimeMap(this.ctx!)
    return m.perf + (c - m.ctxTime) * 1000
  }

  /**
   * (Re)start so that `target(perf)` is heard at every moment from now on. Returns false when the
   * target is past the end of the buffer.
   */
  start(target: (perf: number) => number): boolean {
    const ctx = this.ctx
    const buf = this.buffer
    if (!ctx || !buf || !this.out) return false
    this.stop(0.03)
    let when = ctx.currentTime + 0.08
    let pos = target(this.perfOf(when))
    if (pos < 0) {
      // The song starts a moment from now: schedule the first sample exactly then.
      when -= pos
      pos = 0
    }
    if (pos >= buf.duration - 0.05) return false
    const g = ctx.createGain()
    g.gain.setValueAtTime(0, ctx.currentTime)
    g.gain.setValueAtTime(0, when)
    g.gain.linearRampToValueAtTime(1, when + 0.02)
    g.connect(this.out)
    const src = ctx.createBufferSource()
    src.buffer = buf
    src.connect(g)
    src.start(when, pos)
    src.onended = () => {
      if (this.src === src) {
        this.src = null
        this.srcGain = null
      }
    }
    this.src = src
    this.srcGain = g
    this.anchorCtx = when
    this.anchorPos = pos
    this.rate = 1
    return true
  }

  /** Position being heard right now, with its performance.now() timestamp. */
  heard(): { pos: number; perf: number } | null {
    if (!this.ctx || !this.src) return null
    const m = outputTimeMap(this.ctx)
    return { pos: this.anchorPos + (m.ctxTime - this.anchorCtx) * this.rate, perf: m.perf }
  }

  /** Nudge the playback rate (drift correction). Re-anchors so positions stay exact. */
  setRate(rate: number) {
    const ctx = this.ctx
    if (!ctx || !this.src || Math.abs(rate - this.rate) < 1e-5) return
    const now = Math.max(ctx.currentTime, this.anchorCtx)
    this.anchorPos += (now - this.anchorCtx) * this.rate
    this.anchorCtx = now
    this.rate = rate
    this.src.playbackRate.setValueAtTime(rate, now)
  }

  stop(fade = 0.08) {
    const ctx = this.ctx
    const src = this.src
    const g = this.srcGain
    this.src = null
    this.srcGain = null
    if (!ctx || !src || !g) return
    const t = ctx.currentTime
    g.gain.cancelScheduledValues(t)
    g.gain.setValueAtTime(g.gain.value, t)
    g.gain.linearRampToValueAtTime(0, t + fade)
    src.onended = null
    try {
      src.stop(t + fade + 0.01)
    } catch {
      /* not started */
    }
    window.setTimeout(() => {
      src.disconnect()
      g.disconnect()
    }, (fade + 0.2) * 1000)
  }
}
