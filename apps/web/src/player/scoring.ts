import type { PitchTrack } from '@shared/types'

/** Frequency (Hz) → MIDI note number (float). */
export function hzToMidi(hz: number): number {
  return 69 + 12 * Math.log2(hz / 440)
}

/** Move the singer's note into the octave closest to the reference (octave-insensitive scoring). */
export function foldToRef(user: number, ref: number): number {
  const d = user - ref
  return ref + (d - 12 * Math.round(d / 12))
}

/** Points for one frame given the absolute semitone error (null = singer silent). */
export function frameScore(diff: number | null): number {
  if (diff === null) return 0
  const d = Math.abs(diff)
  if (d <= 0.5) return 1
  if (d <= 1) return 0.7
  if (d <= 2) return 0.35
  return 0
}

/** Reference MIDI at time `t` (seconds), shifted by the current key; null when unvoiced. */
export function sampleRef(track: PitchTrack, t: number, key: number): number | null {
  if (t < 0) return null
  const v = track.midi[Math.round(t / track.hop)]
  return v === null || v === undefined ? null : v + key
}

export interface RefNote {
  /** Start / end in seconds. */
  t0: number
  t1: number
  /** Average MIDI (without key shift). */
  midi: number
}

/** Group voiced reference frames into note bars for the pitch lane. */
export function buildNotes(track: PitchTrack): RefNote[] {
  const notes: RefNote[] = []
  let cur: { t0: number; t1: number; sum: number; n: number } | null = null
  const flush = () => {
    if (cur && cur.t1 - cur.t0 >= 0.06) notes.push({ t0: cur.t0, t1: cur.t1, midi: cur.sum / cur.n })
    cur = null
  }
  track.midi.forEach((m, i) => {
    const t = i * track.hop
    if (m === null) {
      flush()
      return
    }
    if (cur && Math.abs(m - cur.sum / cur.n) <= 0.75) {
      cur.t1 = t + track.hop
      cur.sum += m
      cur.n += 1
    } else {
      flush()
      cur = { t0: t, t1: t + track.hop, sum: m, n: 1 }
    }
  })
  flush()
  return notes
}

/** Index of the note covering time t, or -1 (binary search). */
export function noteAt(notes: RefNote[], t: number): number {
  let lo = 0
  let hi = notes.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const n = notes[mid]!
    if (t < n.t0) hi = mid - 1
    else if (t >= n.t1) lo = mid + 1
    else return mid
  }
  return -1
}

export type RatingTone = 'perfect' | 'great' | 'good' | 'try'

export function rating(score: number): { label: string; tone: RatingTone } {
  if (score >= 90) return { label: 'PERFECT', tone: 'perfect' }
  if (score >= 75) return { label: 'GREAT', tone: 'great' }
  if (score >= 50) return { label: 'GOOD', tone: 'good' }
  return { label: '加油', tone: 'try' }
}

/** Running totals for a song and for the current lyric line. */
export class ScoreKeeper {
  private sum = 0
  private total = 0
  private lineSum = 0
  private lineTotal = 0
  /** Note indexes the singer has hit (score ≥ 0.7 at least once). */
  hits = new Set<number>()

  reset() {
    this.sum = 0
    this.total = 0
    this.lineSum = 0
    this.lineTotal = 0
    this.hits = new Set()
  }

  /** Add one frame; returns the frame's points (or null when the reference is unvoiced). */
  add(ref: number | null, user: number | null): number | null {
    if (ref === null) return null
    const pts = frameScore(user === null ? null : foldToRef(user, ref) - ref)
    this.sum += pts
    this.total += 1
    this.lineSum += pts
    this.lineTotal += 1
    return pts
  }

  get score(): number {
    return this.total ? (100 * this.sum) / this.total : 0
  }

  get frames(): number {
    return this.total
  }

  /** Close the current line; returns its score, or null if too few voiced frames to judge. */
  endLine(minFrames = 12): number | null {
    const res = this.lineTotal >= minFrames ? (100 * this.lineSum) / this.lineTotal : null
    this.lineSum = 0
    this.lineTotal = 0
    return res
  }
}
