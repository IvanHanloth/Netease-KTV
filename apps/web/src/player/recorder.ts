import type { RecordingSegment, RecordingTake } from '@shared/types'
import { api, uploadTake } from '../lib/api'

/**
 * 录制 on the 主屏: the processed microphone (with its reverb, before the speaker level) is
 * recorded during a song, and for every stretch we note which song position it went with, so
 * pauses, seeks and 重唱 line up when the server mixes it with the accompaniment.
 *
 * Switching the microphone off and on starts a new take (its stream is a new one each time).
 */

const MIMES = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4;codecs=mp4a.40.2', 'audio/mp4']

function pickMime(): string {
  if (typeof MediaRecorder === 'undefined') return ''
  return MIMES.find((m) => MediaRecorder.isTypeSupported(m)) ?? ''
}

export const recordingSupported = () => typeof MediaRecorder !== 'undefined' && !!pickMime()

/** Microphone → recorder delay: the device's input buffer plus the mixer's own (ms). */
export function estimateInputLatency(ctx: AudioContext | null | undefined): number {
  return Math.round(((ctx?.baseLatency ?? 0.01) + 0.02) * 1000)
}

/** A jump this big between where the song should be and where it is: a seek (a new stretch). */
const JUMP_S = 0.3
/** Microphone level (raw input RMS) counted as someone singing: about −38 dBFS. */
const VOICE_LEVEL = 0.012
/** Keep a recording only with this much singing in it (ms)… */
const MIN_VOICED_MS = 8_000
/** …and this much of the song recorded. */
const MIN_RECORDED_MS = 20_000

interface Take {
  recorder: MediaRecorder
  mime: string
  chunks: Blob[]
  /** performance.now() when the recorder really started (null until then). */
  startPerf: number | null
  segments: RecordingSegment[]
  open: RecordingSegment | null
  stopped: Promise<void>
}

/** Why a song's recording was not offered: the microphone was off, too little of the song, nobody sang. */
export type RecordingSkip = 'no-mic' | 'too-short' | 'no-voice'

export const skipText: Record<RecordingSkip, string> = {
  'no-mic': '麦克风没开，这首歌没有录音',
  'too-short': '唱的时间太短，没有生成录音',
  'no-voice': '没录到演唱声音，没有生成录音',
}

export interface RecorderTick {
  /** The song is playing (heard), and where it is now (s). */
  playing: boolean
  position: number
  /** Loudest microphone input right now (0..1). */
  level: number
  /** 升降调 of the audio playing, and the room's balance (shared player values). */
  key: number
  micVolume: number
  musicVolume: number
}

export class SongRecorder {
  private takes: Take[] = []
  private current: Take | null = null
  private stream: MediaStream | null = null
  private lastTick = 0
  private voicedMs = 0
  private closed = false
  private mix = { key: 0, micVolume: 0.7, musicVolume: 1 }

  constructor(
    readonly songId: number,
    readonly uid: string,
    /** Input latency estimate (ms), sent along for the mix. */
    private latencyMs: number,
  ) {}

  setLatency(ms: number) {
    this.latencyMs = ms
  }

  /** The microphone stream to record (null: microphone off). */
  setStream(stream: MediaStream | null) {
    if (this.closed || stream === this.stream) return
    this.endTake()
    this.stream = stream
    if (!stream) return
    const mime = pickMime()
    if (!mime) return
    let recorder: MediaRecorder
    try {
      recorder = new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 128_000 })
    } catch {
      return
    }
    const take: Take = { recorder, mime, chunks: [], startPerf: null, segments: [], open: null, stopped: Promise.resolve() }
    take.stopped = new Promise<void>((resolve) => {
      recorder.onstop = () => resolve()
      recorder.onerror = () => resolve()
    })
    recorder.onstart = () => (take.startPerf = performance.now())
    recorder.ondataavailable = (e) => {
      if (e.data.size) take.chunks.push(e.data)
    }
    recorder.start(1000)
    this.takes.push(take)
    this.current = take
  }

  /** Called a few times a second while the song is on. */
  tick(t: RecorderTick) {
    const now = performance.now()
    const dt = this.lastTick ? Math.min(1000, now - this.lastTick) : 0
    this.lastTick = now
    const take = this.current
    if (!take || take.startPerf === null) return
    const rec = now - take.startPerf
    if (t.playing) {
      this.mix = { key: t.key, micVolume: t.micVolume, musicVolume: t.musicVolume }
      if (t.level > VOICE_LEVEL) this.voicedMs += dt
      const open = take.open
      const expected = open ? open.pos + (rec - open.rec) / 1000 : NaN
      if (!open || Math.abs(t.position - expected) > JUMP_S) {
        this.closeSegment(take, rec)
        take.open = { rec, pos: Math.max(0, t.position), dur: 0 }
      }
    } else {
      this.closeSegment(take, rec)
    }
  }

  private closeSegment(take: Take, rec: number) {
    const open = take.open
    if (!open) return
    open.dur = Math.max(0, rec - open.rec)
    if (open.dur > 0) take.segments.push(open)
    take.open = null
  }

  private endTake() {
    const take = this.current
    if (!take) return
    if (take.startPerf !== null) this.closeSegment(take, performance.now() - take.startPerf)
    if (take.recorder.state !== 'inactive') take.recorder.stop()
    this.current = null
  }

  private get recordedMs() {
    return this.takes.reduce((sum, t) => sum + t.segments.reduce((s, x) => s + x.dur, 0), 0)
  }

  /** Why this recording is not worth offering (null: it is). */
  get skipReason(): RecordingSkip | null {
    if (!this.takes.length) return 'no-mic'
    if (this.recordedMs < MIN_RECORDED_MS) return 'too-short'
    if (this.voicedMs < MIN_VOICED_MS) return 'no-voice'
    return null
  }

  /** Stop recording and drop everything. */
  discard() {
    this.closed = true
    this.endTake()
    this.takes = []
  }

  /** Stop, and upload when there is enough singing in it. */
  async finish(singer?: string): Promise<{ id: string } | { skipped: RecordingSkip }> {
    this.closed = true
    this.endTake()
    const skip = this.skipReason
    console.info('[录制] 本曲', { recordedMs: Math.round(this.recordedMs), voicedMs: Math.round(this.voicedMs), skip })
    if (skip) {
      this.takes = []
      return { skipped: skip }
    }
    const takes = this.takes.filter((t) => t.segments.length)
    await Promise.all(takes.map((t) => t.stopped))
    const blobs = takes.map((t) => new Blob(t.chunks, { type: t.mime.split(';')[0] }))
    const meta: RecordingTake[] = takes.map((t) => ({ mime: t.mime, segments: t.segments }))
    this.takes = []
    const { id } = await api.createRecording({
      songId: this.songId,
      key: this.mix.key,
      ...(singer ? { singer } : {}),
      takes: meta,
      latencyMs: Math.round(Math.max(0, Math.min(1000, this.latencyMs))),
      micVolume: this.mix.micVolume,
      musicVolume: this.mix.musicVolume,
    })
    for (let n = 0; n < blobs.length; n++) await uploadTake(id, n, blobs[n]!)
    await api.finishRecording(id)
    return { id }
  }
}
