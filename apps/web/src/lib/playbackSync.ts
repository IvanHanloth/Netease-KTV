import type { PlaybackSync } from '@shared/types'
import { toServerTime } from './clock'

/**
 * Following the sound-playing TV from elsewhere (移动耳返, silent extra screens).
 *
 * The active TV reports "at server time `at` its speakers played `position` of song `uid`"; with
 * the server clock known locally (lib/clock.ts) that is a straight line we can read at any time.
 */

/**
 * Smooth the TV's reports: each one predicts a line pos(t). Reports of the same uninterrupted
 * playback agree within a few ms; average them in so clock-estimate jitter doesn't shake the
 * follower. A real jump (seek, pause, new song) replaces the line.
 */
export function smoothSync(prev: PlaybackSync | null, next: PlaybackSync): PlaybackSync {
  if (!prev || prev.uid !== next.uid || prev.epoch !== next.epoch || !prev.playing || !next.playing) return next
  const predicted = prev.position + (next.at - prev.at) / 1000
  const err = next.position - predicted
  if (Math.abs(err) > 0.05) return next
  return { ...next, position: predicted + err * 0.3 }
}

/** TV timeline position (s) at local time `perf` (performance.now()); null when unknown. */
export function tvPosition(sync: PlaybackSync | null, perf: number): number | null {
  if (!sync) return null
  if (!sync.playing) return sync.position
  const server = toServerTime(perf)
  if (server === null) return null
  return sync.position + (server - sync.at) / 1000
}

/** What the TV visuals (lyrics, progress, MV) need to know about playback. AudioEngine has it too. */
export interface PlaybackClock {
  position(): number
  readonly playing: boolean
  readonly hasTrack: boolean
  readonly duration: number
}

/** A silent screen's clock: follows the sound-playing TV's reports instead of local audio. */
export class MirrorClock implements PlaybackClock {
  private sync: PlaybackSync | null = null
  /** The song this screen shows (reports for another song are ignored). */
  uid: string | null = null
  epoch = 0
  /** Seconds (from the song metadata: the audio isn't loaded here). */
  duration = 0

  update(next: PlaybackSync) {
    this.sync = smoothSync(this.sync, next)
  }

  get hasTrack() {
    const s = this.sync
    return !!s && s.uid === this.uid && s.epoch === this.epoch
  }

  get playing() {
    return this.hasTrack && this.sync!.playing
  }

  position() {
    if (!this.hasTrack) return 0
    const at = this.positionAt(performance.now())
    // Clock not calibrated yet: the last reported position is the best guess.
    const p = Number.isFinite(at) ? at : this.sync!.position
    return Math.max(0, this.duration > 0 ? Math.min(this.duration, p) : p)
  }

  /** Unclamped 主屏 position heard at local time `perf` (NaN when unknown): for audio following. */
  positionAt(perf: number): number {
    if (!this.hasTrack) return NaN
    return tvPosition(this.sync, perf) ?? NaN
  }
}
