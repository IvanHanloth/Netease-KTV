/**
 * Web Audio engine for the TV page: plays an accompaniment buffer and an optional
 * lead-vocal buffer in sample-accurate sync, each with its own gain.
 *
 * Every play() opens a "session" (fresh gain nodes + sources). Ending a session
 * schedules a short gain ramp and a matching source stop on the audio clock, so
 * pause / seek / song changes never click and never race a newer session.
 * Switching 伴唱 ⇄ 原唱 with stems is just a vocal-gain ramp: no reload, no gap.
 */
import { vocalActivity, type LeadSegment, type VocalActivity } from '../lib/leadVocal'

type GainParam = Pick<AudioParam, 'cancelScheduledValues' | 'setValueAtTime' | 'linearRampToValueAtTime' | 'setTargetAtTime'>

/**
 * Write the lead-vocal gain timeline onto `g`, starting at audio-clock time `now` (playback
 * position `pos`): the level for right now, then up at each upcoming 领唱 segment start and back
 * down at its end. Buffer time p maps to audio-clock time startCtxTime + (p − startOffset), the
 * same mapping the sources were started with, so the switches are sample-exact.
 */
export function scheduleVocalGain(
  g: GainParam,
  o: {
    now: number
    pos: number
    startCtxTime: number
    startOffset: number
    base: number
    lead: number
    segments: LeadSegment[]
    fadeIn: boolean
  },
) {
  const segs = o.lead > o.base + 1e-3 ? o.segments : []
  const level = segs.some((x) => o.pos >= x.start && o.pos < x.end) ? o.lead : o.base
  g.cancelScheduledValues(o.now)
  if (o.fadeIn) {
    g.setValueAtTime(0, o.now)
    g.linearRampToValueAtTime(level, o.now + 0.03)
  } else {
    g.setTargetAtTime(level, o.now, RAMP_TC)
  }
  const at = (p: number) => Math.max(o.now + 0.001, o.startCtxTime + (p - o.startOffset))
  for (const x of segs) {
    if (x.end <= o.pos) continue
    if (x.start > o.pos) g.setTargetAtTime(o.lead, at(x.start), LEAD_ATTACK_TC)
    // Soft release: an exponential fade that is ~95 % done after `fade` seconds.
    const fade = x.fade ?? LEAD_RELEASE_TC * 3
    g.setTargetAtTime(o.base, at(Math.max(x.start, x.end - Math.min(0.15, fade / 2))), fade / 3)
  }
}

/**
 * A matching (audio-clock time, performance.now() time) pair for the sample being heard right now.
 * getOutputTimestamp() includes the output latency; without it, estimate from the latency fields.
 */
export function outputTimeMap(ctx: AudioContext): { ctxTime: number; perf: number } {
  const ts = typeof ctx.getOutputTimestamp === 'function' ? ctx.getOutputTimestamp() : null
  if (ts && ts.contextTime && ts.performanceTime) return { ctxTime: ts.contextTime, perf: ts.performanceTime }
  const latency = (ctx.outputLatency || 0) + (ctx.baseLatency || 0)
  return { ctxTime: ctx.currentTime - latency, perf: performance.now() }
}

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
/** 领唱: open fast (the segment already starts a little before the vocal onset)… */
const LEAD_ATTACK_TC = 0.02
/** …and fade back to the accompaniment gently so a held note isn't cut off. */
const LEAD_RELEASE_TC = 0.12
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
  /** Vocal level inside 领唱 segments. */
  private lead = 0.3
  private leadSegs: LeadSegment[] = []
  private activity = new WeakMap<AudioBuffer, VocalActivity>()
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

  private keepAwakeNode: OscillatorNode | null = null

  /**
   * Keep the audio output busy with an inaudible signal (20 Hz at −60 dBFS). Between songs Web
   * Audio is silent, and HDMI TVs, amplifiers, Bluetooth speakers and some sound cards power down
   * on silence; waking up takes seconds, which swallowed the start of the next song.
   */
  keepAwake(on: boolean) {
    const ctx = this.ctx
    if (!on || !ctx) {
      this.keepAwakeNode?.stop()
      this.keepAwakeNode?.disconnect()
      this.keepAwakeNode = null
      return
    }
    if (this.keepAwakeNode) return
    const osc = ctx.createOscillator()
    osc.frequency.value = 20
    const g = ctx.createGain()
    g.gain.value = 0.001
    osc.connect(g).connect(ctx.destination)
    osc.start()
    this.keepAwakeNode = osc
  }

  /** The audio clock is running (resumes a suspended context; false if the browser refuses). */
  async ensureRunning(): Promise<boolean> {
    const ctx = this.ctx
    if (!ctx) return false
    if (ctx.state !== 'running') {
      try {
        await ctx.resume()
      } catch {
        /* needs a user gesture */
      }
    }
    return ctx.state === 'running'
  }

  get hasTrack() {
    return !!this.main
  }

  position() {
    if (!this.ctx || !this.main) return 0
    if (!this.playing) return this.pausedAt
    return Math.max(0, Math.min(this.main.duration, this.startOffset + (this.ctx.currentTime - this.startCtxTime)))
  }

  /**
   * What the speakers are playing right now: buffer position plus the performance.now() time at
   * which that sample is heard (output latency included). Used to stamp position reports so
   * 耳返 phones can line up with the TV.
   */
  outputClock(): { position: number; perf: number } {
    const ctx = this.ctx
    if (!ctx || !this.main || !this.playing) return { position: this.pausedAt, perf: performance.now() }
    const map = outputTimeMap(ctx)
    return { position: this.startOffset + (map.ctxTime - this.startCtxTime), perf: map.perf }
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
    this.leadSegs = []
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
    this.leadSegs = []
  }

  /**
   * Start so that `target(perf)` is heard at every moment from now on (perf = performance.now()
   * time at which a sample comes out of the speakers): a 大屏 that isn't the 主屏 uses it to play
   * in step with the 主屏's reports. Returns false when the target is past the end.
   */
  playAligned(target: (perf: number) => number): boolean {
    const ctx = this.ctx
    if (!ctx || !this.main) return false
    let when = ctx.currentTime + 0.1
    const m = outputTimeMap(ctx)
    let pos = target(m.perf + (when - m.ctxTime) * 1000)
    if (!Number.isFinite(pos)) return false
    if (pos < 0) {
      when -= pos
      pos = 0
    }
    if (pos >= this.main.duration - 0.05) return false
    this.play(pos, when)
    return true
  }

  play(offset = this.pausedAt, startAt?: number) {
    if (!this.ctx || !this.main) return
    this.endSession(0.02)
    const ctx = this.ctx
    const at = Math.max(0, Math.min(offset, this.main.duration - 0.05))
    const when = startAt ?? ctx.currentTime + 0.05
    const gen = ++this.gen
    const mkGain = (target: number) => {
      const g = ctx.createGain()
      g.gain.setValueAtTime(0, ctx.currentTime)
      g.gain.setValueAtTime(0, when)
      g.gain.linearRampToValueAtTime(target, when + 0.03) // tiny fade-in, no click
      g.connect(ctx.destination)
      return g
    }
    // The vocal gain starts silent; scheduleVocal() below adds its fade-in and the 领唱 automation.
    const vocalGain = ctx.createGain()
    vocalGain.gain.setValueAtTime(0, ctx.currentTime)
    vocalGain.connect(ctx.destination)
    const session: Session = { music: mkGain(this.music), vocal: vocalGain, sources: [] }
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
    this.scheduleVocal(true, when, at)
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

  /**
   * Target gains; changes ramp smoothly (no zipper noise, seamless 伴唱/原唱 switch).
   * `lead` is the vocal level used inside 领唱 segments (≤ `vocal` disables them).
   */
  setVolumes(music: number, vocal: number, lead = vocal) {
    this.music = music
    this.vocal = vocal
    this.lead = lead
    const s = this.session
    if (!this.ctx || !s) return
    s.music.gain.setTargetAtTime(music, this.ctx.currentTime, RAMP_TC)
    this.scheduleVocal(false)
  }

  /** 领唱 segments in buffer seconds (see lib/leadVocal.ts); [] turns 领唱 off. */
  setLeadSegments(segments: LeadSegment[]) {
    this.leadSegs = segments
    this.scheduleVocal(false)
  }

  /** RMS envelope of the loaded lead-vocal stem (computed once per buffer, ~30 ms). */
  vocalActivity(): VocalActivity | null {
    const buf = this.vocals
    if (!buf) return null
    let a = this.activity.get(buf)
    if (!a) {
      const channels = Array.from({ length: buf.numberOfChannels }, (_, i) => buf.getChannelData(i))
      a = vocalActivity(channels, buf.sampleRate)
      this.activity.set(buf, a)
    }
    return a
  }

  /**
   * (Re)build the vocal-gain timeline on the audio clock: the current level now, then a ramp up
   * at every upcoming 领唱 segment start and back down at its end. Because both stems play from
   * the same start time, the switch lands on the exact sample the schedule says.
   */
  private scheduleVocal(fadeIn: boolean, fromCtx?: number, fromPos?: number) {
    const s = this.session
    const ctx = this.ctx
    if (!s || !ctx) return
    scheduleVocalGain(s.vocal.gain, {
      now: fromCtx ?? ctx.currentTime,
      pos: fromPos ?? this.position(),
      startCtxTime: this.startCtxTime,
      startOffset: this.startOffset,
      base: this.vocal,
      lead: this.lead,
      segments: this.leadSegs,
      fadeIn,
    })
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
