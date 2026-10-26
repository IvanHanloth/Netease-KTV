import type { LyricLine, Lyrics, PitchTrack } from '@shared/types'

/** Frequency (Hz) → MIDI note number (float). */
export function hzToMidi(hz: number): number {
  return 69 + 12 * Math.log2(hz / 440)
}

/** Move the singer's note into the octave closest to the reference (octave-insensitive scoring). */
export function foldToRef(user: number, ref: number): number {
  const d = user - ref
  return ref + (d - 12 * Math.round(d / 12))
}

/** Default / preset pitch tolerances in semitones (full credit within ±T). */
export const TOLERANCE_PRESETS = [
  { label: '宽松', value: 1.5 },
  { label: '标准', value: 1.0 },
  { label: '严格', value: 0.5 },
] as const
export const DEFAULT_TOLERANCE = 1.0

/**
 * Credit for one frame from the absolute semitone error `d`:
 * full credit up to T, then fading linearly to 0 at 3T.
 */
export function frameCredit(d: number, tolerance: number): number {
  const t = Math.max(0.05, tolerance)
  if (d <= t) return 1
  if (d >= 3 * t) return 0
  return 1 - (d - t) / (2 * t)
}

/** Raw accuracy (0..1) → displayed score (0..100). Singing ~90% of the scored frames right is a 100. */
export function normalizeScore(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return 0
  return Math.max(0, Math.min(100, Math.round(100 * Math.pow(Math.min(1, raw / 0.9), 0.75))))
}

/** Reference MIDI at time `t` (seconds), shifted by the current key; null when unvoiced. */
export function sampleRef(track: PitchTrack, t: number, key: number): number | null {
  if (t < 0) return null
  const v = track.midi[Math.round(t / track.hop)]
  return v === null || v === undefined ? null : v + key
}

/** Timing tolerance: the singer's pitch is compared with the reference within ±this window. */
export const TIMING_WINDOW_S = 0.25

/**
 * Smallest octave-folded error between the singer and any voiced reference frame within
 * ±TIMING_WINDOW_S of frame `idx`. Returns the error and the matched (key-shifted) reference.
 */
export function bestMatch(
  track: PitchTrack,
  idx: number,
  key: number,
  user: number,
): { err: number; ref: number } | null {
  const w = Math.max(1, Math.round(TIMING_WINDOW_S / track.hop))
  let best: { err: number; ref: number } | null = null
  for (let i = Math.max(0, idx - w); i <= Math.min(track.midi.length - 1, idx + w); i++) {
    const m = track.midi[i]
    if (m === null || m === undefined) continue
    const ref = m + key
    const err = Math.abs(foldToRef(user, ref) - ref)
    if (!best || err < best.err) best = { err, ref }
  }
  return best
}

// ---------- limiting the reference to the lyrics ----------
//
// Separation is never perfect: backing vocals / harmonies leak into the vocal stem and show up as
// reference pitch where nobody is meant to sing (intros, interludes, ad-libs between lines).
// When the song has lyrics, only the reference inside the sung lyrics is kept.

/** Word-timed lyrics: margin kept before a word starts and after it ends (timing slack, held notes). */
const WORD_LEAD_S = 0.2
const WORD_TAIL_S = 0.4
/** Line-timed lyrics: margin before a line starts (line stamps are rougher than word stamps). */
const LINE_LEAD_S = 0.5
/**
 * Line-timed lyrics only say when a line starts; the server has it last until the next line,
 * at most 10 s, so the intro, the outro and long interludes are still cut.
 */
const lineSpanS = (l: LyricLine) => l.d / 1000
/** Pauses shorter than this between sung spans stay scored (breaths between words / lines). */
const BRIDGE_S = 0.8
/**
 * A note that starts inside the lyrics is kept to its end, at most this far past them: word
 * timings often stop early on a held last word. Notes that only start in a gap are dropped.
 */
const HOLD_S = 2
/**
 * If the lyrics would drop more than this share of the voiced reference, they probably don't
 * match this audio (another version, wrong timing): the reference is then left as it is.
 */
const MAX_DROPPED = 0.5

/** Time spans (seconds, sorted and merged) in which the lyrics are being sung. */
export function lyricSpans(lyrics: Lyrics): [number, number][] {
  const raw: [number, number][] = []
  for (const l of lyrics.lines) {
    if (lyrics.kind === 'yrc' && l.words.length) {
      for (const w of l.words) if (w.text.trim()) raw.push([w.t / 1000 - WORD_LEAD_S, (w.t + w.d) / 1000 + WORD_TAIL_S])
    } else {
      raw.push([l.t / 1000 - LINE_LEAD_S, l.t / 1000 + lineSpanS(l)])
    }
  }
  raw.sort((a, b) => a[0] - b[0])
  const out: [number, number][] = []
  for (const s of raw) {
    const last = out.at(-1)
    if (last && s[0] - last[1] < BRIDGE_S) last[1] = Math.max(last[1], s[1])
    else out.push([s[0], s[1]])
  }
  return out
}

/**
 * The reference with every frame outside the sung lyrics made silent, so it is neither scored
 * nor drawn. Returned unchanged without lyrics, or when the lyrics don't seem to fit the audio.
 */
export function limitToLyrics(track: PitchTrack, lyrics: Lyrics | undefined): PitchTrack {
  if (!lyrics || lyrics.kind === 'none' || !lyrics.lines.length) return track
  const keep = new Uint8Array(track.midi.length)
  for (const [a, b] of lyricSpans(lyrics)) {
    const i0 = Math.max(0, Math.ceil(a / track.hop))
    const i1 = Math.min(keep.length - 1, Math.floor(b / track.hop))
    for (let i = i0; i <= i1; i++) keep[i] = 1
  }
  // Let held notes run on: a voiced stretch that is kept where it leaves the lyrics continues.
  const hold = Math.round(HOLD_S / track.hop)
  for (let i = 1, left = 0; i < keep.length; i++) {
    if (keep[i]) left = hold
    else if (left > 0 && track.midi[i] !== null && track.midi[i - 1] !== null && keep[i - 1]) {
      keep[i] = 1
      left--
    } else left = 0
  }
  let voiced = 0
  let dropped = 0
  const midi = track.midi.map((m, i) => {
    if (m === null) return null
    voiced++
    if (keep[i]) return m
    dropped++
    return null
  })
  if (!dropped || dropped > voiced * MAX_DROPPED) return track
  return { ...track, midi }
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

/** Minimum note length that is scored, and the transition trimmed at each end of a note. */
const MIN_NOTE_S = 0.12
const EDGE_S = 0.06

/**
 * Per-frame mask of reference frames that count towards the score: frames inside a note
 * ≥ 120 ms long, excluding the first / last 60 ms (onsets, glides, breaths).
 */
export function buildScoreMask(track: PitchTrack, notes: RefNote[]): Uint8Array {
  const mask = new Uint8Array(track.midi.length)
  for (const n of notes) {
    if (n.t1 - n.t0 < MIN_NOTE_S) continue
    const a = Math.ceil((n.t0 + EDGE_S) / track.hop)
    const b = Math.floor((n.t1 - EDGE_S) / track.hop)
    for (let i = Math.max(0, a); i <= Math.min(mask.length - 1, b); i++) if (track.midi[i] !== null) mask[i] = 1
  }
  return mask
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

/** Running totals for a song and for the current lyric line (scores are normalized 0–100). */
export class ScoreKeeper {
  private sum = 0
  private total = 0
  private lineSum = 0
  private lineTotal = 0
  /** Note indexes the singer has hit (credit ≥ 0.7 at least once). */
  hits = new Set<number>()

  reset() {
    this.sum = 0
    this.total = 0
    this.lineSum = 0
    this.lineTotal = 0
    this.hits = new Set()
  }

  /**
   * Add one scored frame. `err` is the singer's best semitone error, or null when the
   * singer is silent. Returns the frame's credit.
   */
  add(err: number | null, tolerance: number): number {
    const pts = err === null ? 0 : frameCredit(err, tolerance)
    this.sum += pts
    this.total += 1
    this.lineSum += pts
    this.lineTotal += 1
    return pts
  }

  get score(): number {
    return this.total ? normalizeScore(this.sum / this.total) : 0
  }

  get frames(): number {
    return this.total
  }

  /** Close the current line; returns its score, or null if too few scored frames to judge. */
  endLine(minFrames = 12): number | null {
    const res = this.lineTotal >= minFrames ? normalizeScore(this.lineSum / this.lineTotal) : null
    this.lineSum = 0
    this.lineTotal = 0
    return res
  }
}
