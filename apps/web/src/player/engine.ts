/**
 * Web Audio engine for the TV page: plays an accompaniment buffer and an optional
 * lead-vocal buffer in sample-accurate sync, each with its own gain.
 */
export interface TrackUrls {
  main: string
  vocals?: string
}

export class AudioEngine {
  ctx: AudioContext | null = null
  private musicGain: GainNode | null = null
  private vocalGain: GainNode | null = null
  private main: AudioBuffer | null = null
  private vocals: AudioBuffer | null = null
  private sources: AudioBufferSourceNode[] = []
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
      this.musicGain = this.ctx.createGain()
      this.vocalGain = this.ctx.createGain()
      this.musicGain.connect(this.ctx.destination)
      this.vocalGain.connect(this.ctx.destination)
      this.applyGains()
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
    return Math.min(this.main.duration, this.startOffset + (this.ctx.currentTime - this.startCtxTime))
  }

  // No abort signal here: the promise is cached and may be shared by a later load.
  private fetchBuffer(url: string): Promise<AudioBuffer> {
    const hit = this.cache.get(url)
    if (hit) return hit
    const p = (async () => {
      const res = await fetch(url)
      if (!res.ok) throw new Error(`音频加载失败（${res.status}）`)
      const data = await res.arrayBuffer()
      if (!this.ctx) throw new Error('AudioContext 未初始化')
      return await this.ctx.decodeAudioData(data)
    })()
    this.cache.set(url, p)
    p.catch(() => this.cache.delete(url))
    // keep the cache small: decoded buffers are large
    while (this.cache.size > 4) {
      const first = this.cache.keys().next().value as string
      this.cache.delete(first)
    }
    return p
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
    this.stopSources()
    this.playing = false
    this.main = main
    this.vocals = vocals
    this.pausedAt = 0
    this.loadedKey = key
    return true
  }

  unload() {
    this.stopSources()
    this.playing = false
    this.main = null
    this.vocals = null
    this.pausedAt = 0
    this.loadedKey = ''
  }

  play(offset = this.pausedAt) {
    if (!this.ctx || !this.main) return
    this.stopSources()
    const at = Math.max(0, Math.min(offset, this.main.duration - 0.05))
    const when = this.ctx.currentTime + 0.05
    const gen = ++this.gen
    const mk = (buf: AudioBuffer, gain: GainNode) => {
      const src = this.ctx!.createBufferSource()
      src.buffer = buf
      src.connect(gain)
      src.start(when, at)
      return src
    }
    const mainSrc = mk(this.main, this.musicGain!)
    this.sources = [mainSrc]
    if (this.vocals) this.sources.push(mk(this.vocals, this.vocalGain!))
    mainSrc.onended = () => {
      if (gen !== this.gen || !this.playing) return
      this.playing = false
      this.pausedAt = this.main?.duration ?? 0
      this.onEnded?.()
    }
    this.startCtxTime = when
    this.startOffset = at
    this.playing = true
  }

  pause() {
    if (!this.playing) return
    this.pausedAt = this.position()
    this.playing = false
    this.stopSources()
  }

  seek(sec: number) {
    const wasPlaying = this.playing
    this.pausedAt = Math.max(0, Math.min(sec, this.duration))
    if (wasPlaying) this.play(this.pausedAt)
  }

  setVolumes(music: number, vocal: number) {
    this.music = music
    this.vocal = vocal
    this.applyGains()
  }

  private applyGains() {
    if (!this.ctx || !this.musicGain || !this.vocalGain) return
    const t = this.ctx.currentTime
    this.musicGain.gain.setTargetAtTime(this.music, t, 0.04)
    this.vocalGain.gain.setTargetAtTime(this.vocal, t, 0.04)
  }

  private stopSources() {
    this.gen++
    for (const s of this.sources) {
      try {
        s.onended = null
        s.stop()
      } catch {
        /* already stopped */
      }
      s.disconnect()
    }
    this.sources = []
  }
}
