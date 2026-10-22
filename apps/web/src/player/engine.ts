/**
 * Web Audio engine for the TV page: plays an accompaniment buffer and an optional
 * lead-vocal buffer in sample-accurate sync, each with its own gain.
 *
 * Every play() opens a "session" (fresh gain nodes + sources). Ending a session
 * schedules a short gain ramp and a matching source stop on the audio clock, so
 * pause / seek / song changes never click and never race a newer session.
 * Switching 伴唱 ⇄ 原唱 with stems is just a vocal-gain ramp: no reload, no gap.
 */
export interface TrackUrls {
  main: string
  vocals?: string
}

interface Session {
  music: GainNode
  vocal: GainNode
  sources: AudioBufferSourceNode[]
}

/** Gain time constant for volume / mode changes (~80 ms). */
const RAMP_TC = 0.08
/** Decoded buffers kept around: current song (2 stems) + prefetched next song (2 stems). */
const CACHE_SIZE = 4

export class AudioEngine {
  ctx: AudioContext | null = null
  private main: AudioBuffer | null = null
  private vocals: AudioBuffer | null = null
  private session: Session | null = null
  private startCtxTime = 0
  private startOffset = 0
  private pausedAt = 0
  private gen = 0
  private cache = new Map<string, Promise<AudioBuffer>>()
  private music = 0.8
  private vocal = 0.3
  playing = false
  loadedKey = ''
  /** Position / playing state right before the last successful load (for seamless key changes). */
  lastPosition = 0
  lastPlaying = false
  onEnded: (() => void) | null = null

  get unlocked() {
    return !!this.ctx && this.ctx.state === 'running'
  }

  async unlock() {
    if (!this.ctx) {
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      this.ctx = new Ctx({ latencyHint: 'playback' })
    }
    if (this.ctx.state !== 'running') await this.ctx.resume()
  }

  get duration() {
    return this.main?.duration ?? 0
  }

  get hasTrack() {
    return !!this.main
  }

  position() {
    if (!this.ctx || !this.main) return 0
    if (!this.playing) return this.pausedAt
    return Math.max(0, Math.min(this.main.duration, this.startOffset + (this.ctx.currentTime - this.startCtxTime)))
  }

  // No abort signal here: the promise is cached and may be shared by a later load.
  private fetchBuffer(url: string): Promise<AudioBuffer> {
    const hit = this.cache.get(url)
    if (hit) {
      // LRU: mark as recently used
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
    // decoded buffers are large: keep only the most recent few
    while (this.cache.size > CACHE_SIZE) {
      const oldest = this.cache.keys().next().value as string
      this.cache.delete(oldest)
    }
    return p
  }

  /** Download + decode in the background so a later load() of these URLs is instant. */
  prefetch(urls: string[]) {
    if (!this.ctx) return
    for (const u of urls) this.fetchBuffer(u).catch(() => {})
  }

  /** Load new buffers. Keeps playing state off; caller decides when to play. */
  async load(key: string, urls: TrackUrls, signal?: AbortSignal) {
    if (!this.ctx) throw new Error('AudioContext 未初始化')
    const [main, vocals] = await Promise.all([
      this.fetchBuffer(urls.main),
      urls.vocals ? this.fetchBuffer(urls.vocals) : Promise.resolve(null),
    ])
    if (signal?.aborted) return false
    this.lastPosition = this.position()
    this.lastPlaying = this.playing
    this.endSession(0.02)
    this.playing = false
    this.main = main
    this.vocals = vocals
    this.pausedAt = 0
    this.loadedKey = key
    return true
  }

  /** Stop and forget the current track, fading it out over `fadeSec`. */
  unload(fadeSec = 0.02) {
    this.endSession(fadeSec)
    this.playing = false
    this.main = null
    this.vocals = null
    this.pausedAt = 0
    this.loadedKey = ''
  }

  play(offset = this.pausedAt) {
    if (!this.ctx || !this.main) return
    this.endSession(0.02)
    const ctx = this.ctx
    const at = Math.max(0, Math.min(offset, this.main.duration - 0.05))
    const when = ctx.currentTime + 0.05
    const gen = ++this.gen
    const mkGain = (target: number) => {
      const g = ctx.createGain()
      g.gain.setValueAtTime(0, ctx.currentTime)
      g.gain.setValueAtTime(0, when)
      g.gain.linearRampToValueAtTime(target, when + 0.03) // tiny fade-in, no click
      g.connect(ctx.destination)
      return g
    }
    const session: Session = { music: mkGain(this.music), vocal: mkGain(this.vocal), sources: [] }
    const mk = (buf: AudioBuffer, gain: GainNode) => {
      const src = ctx.createBufferSource()
      src.buffer = buf
      src.connect(gain)
      src.start(when, at)
      return src
    }
    const mainSrc = mk(this.main, session.music)
    session.sources.push(mainSrc)
    if (this.vocals) session.sources.push(mk(this.vocals, session.vocal))
    mainSrc.onended = () => {
      if (gen !== this.gen || !this.playing) return
      this.playing = false
      this.pausedAt = this.main?.duration ?? 0
      this.session = null
      this.onEnded?.()
    }
    this.session = session
    this.startCtxTime = when
    this.startOffset = at
    this.playing = true
  }

  pause() {
    if (!this.playing) return
    this.pausedAt = this.position()
    this.playing = false
    this.endSession(0.03)
  }

  seek(sec: number) {
    const wasPlaying = this.playing
    this.pausedAt = Math.max(0, Math.min(sec, this.duration))
    if (wasPlaying) this.play(this.pausedAt)
  }

  /** Target gains; changes ramp smoothly (no zipper noise, seamless 伴唱/原唱 switch). */
  setVolumes(music: number, vocal: number) {
    this.music = music
    this.vocal = vocal
    const s = this.session
    if (!this.ctx || !s) return
    const t = this.ctx.currentTime
    s.music.gain.setTargetAtTime(music, t, RAMP_TC)
    s.vocal.gain.setTargetAtTime(vocal, t, RAMP_TC)
  }

  /** Ramp the current session to silence and stop its sources, all scheduled on the audio clock. */
  private endSession(fadeSec: number) {
    const s = this.session
    this.gen++
    this.session = null
    if (!s || !this.ctx) return
    const t = this.ctx.currentTime
    for (const g of [s.music, s.vocal]) {
      g.gain.cancelScheduledValues(t)
      g.gain.setValueAtTime(g.gain.value, t)
      g.gain.linearRampToValueAtTime(0, t + fadeSec)
    }
    for (const src of s.sources) {
      src.onended = null
      try {
        src.stop(t + fadeSec + 0.01)
      } catch {
        /* not started / already stopped */
      }
    }
    window.setTimeout(
      () => {
        for (const src of s.sources) src.disconnect()
        s.music.disconnect()
        s.vocal.disconnect()
      },
      (fadeSec + 0.2) * 1000,
    )
  }
}
