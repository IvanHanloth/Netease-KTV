import type { LyricLine } from '@shared/types'
import { currentLineIndex, lineEnd, sectionStarts } from './lyrics'

/**
 * 领唱 (lead-in vocal): the first line of the song and the first line after every interlude are
 * sung with the original lead vocal, then it drops back to the accompaniment.
 *
 * Lyric timestamps can be off by a few hundred ms (more for line-timed LRC), so each segment is
 * snapped to where the separated lead vocal is actually audible: the onset is searched around the
 * lyric start, the release is followed past the last word until the vocal goes quiet. The gain
 * changes themselves are scheduled on the AudioContext clock by the engine, so they are exact.
 */

export interface VocalActivity {
  /** Seconds per frame. */
  hop: number
  /** RMS per frame (mono). */
  rms: Float32Array
  /** Frames above this are "singing". */
  threshold: number
}

export interface LeadSegment {
  /** Buffer time in seconds. */
  start: number
  end: number
  /** Fade-out length (s), starting slightly before `end`. */
  fade: number
}

const HOP_S = 0.01
const PRE_ROLL_S = 0.12 // open a little before the onset so the first consonant isn't clipped
const TAIL_S = 0.12 // keep the natural release of the last word
const ONSET_SEARCH_BEFORE_S = 0.6
const ONSET_SEARCH_AFTER_S = 0.5
const ONSET_MIN_S = 0.06 // sustained energy needed to count as an onset
const RELEASE_SEARCH_S = 1.5
const RELEASE_SILENCE_S = 0.25 // this much quiet after the last word = the line is over
const NEXT_LINE_GUARD_S = 0.08
/** Vocal fade-out at the end of a 领唱 line: begins this much before the segment end… */
const FADE_LEAD_S = 0.15
/** …and lasts this long, depending on the pause before the next line. */
const MIN_FADE_S = 0.2
const MAX_FADE_S = 0.8

/** RMS envelope of the lead-vocal stem (all channels mixed), 10 ms frames. */
export function vocalActivity(channels: Float32Array[], sampleRate: number): VocalActivity {
  const hopN = Math.max(1, Math.round(sampleRate * HOP_S))
  const len = channels[0]?.length ?? 0
  const frames = Math.floor(len / hopN)
  const rms = new Float32Array(frames)
  const k = 1 / channels.length
  for (let f = 0; f < frames; f++) {
    let sum = 0
    const from = f * hopN
    for (let i = from; i < from + hopN; i++) {
      let s = 0
      for (const ch of channels) s += ch[i]!
      s *= k
      sum += s * s
    }
    rms[f] = Math.sqrt(sum / hopN)
  }
  // Threshold from the loud end of the distribution: robust to quiet songs and to bleed.
  const sorted = Float32Array.from(rms).sort()
  const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0
  const p30 = sorted[Math.floor(sorted.length * 0.3)] ?? 0
  return { hop: HOP_S, rms, threshold: Math.max(p95 * 0.1, p30 * 2, 1e-4) }
}

/** Lines that get the lead vocal: the section starts (same rule as the countdown dots). */
export const leadLineIndexes = sectionStarts

function snapOnset(a: VocalActivity, nominal: number): number | null {
  const from = Math.max(0, Math.floor((nominal - ONSET_SEARCH_BEFORE_S) / a.hop))
  const to = Math.min(a.rms.length - 1, Math.ceil((nominal + ONSET_SEARCH_AFTER_S) / a.hop))
  const need = Math.round(ONSET_MIN_S / a.hop)
  let run = 0
  for (let f = from; f <= to; f++) {
    run = a.rms[f]! > a.threshold ? run + 1 : 0
    if (run >= need) return (f - need + 1) * a.hop
  }
  return null
}

function snapRelease(a: VocalActivity, lastWordEnd: number, limit: number): number | null {
  const from = Math.max(0, Math.floor((lastWordEnd - 0.3) / a.hop))
  const to = Math.min(a.rms.length - 1, Math.floor(Math.min(lastWordEnd + RELEASE_SEARCH_S, limit) / a.hop))
  const quietNeed = Math.round(RELEASE_SILENCE_S / a.hop)
  let lastActive: number | null = null
  let quiet = 0
  for (let f = from; f <= to; f++) {
    if (a.rms[f]! > a.threshold) {
      lastActive = f
      quiet = 0
    } else if (++quiet >= quietNeed && f * a.hop > lastWordEnd) break
  }
  return lastActive === null ? null : (lastActive + 1) * a.hop
}

/** Lead-vocal segments for the given lines (buffer seconds), snapped to the actual vocal. */
function segmentsFor(lines: LyricLine[], indexes: number[], activity: VocalActivity | null): LeadSegment[] {
  const segs: LeadSegment[] = []
  for (const i of indexes) {
    const line = lines[i]
    if (!line) continue
    const nextStart = lines[i + 1] ? lines[i + 1]!.t / 1000 : Infinity
    const s0 = line.t / 1000
    const e0 = lineEnd(line) / 1000
    const limit = nextStart - NEXT_LINE_GUARD_S
    const onset = activity ? snapOnset(activity, s0) : null
    const release = activity ? snapRelease(activity, e0, limit) : null
    const start = Math.max(0, (onset ?? s0) - PRE_ROLL_S)
    const end = Math.min(limit, Math.max(release ?? e0, e0 - 0.2) + TAIL_S)
    // Fade the vocal out instead of cutting it: start a little before the end and take as long as
    // the pause before the next line allows (so the next line is never sung by the original).
    const fade = Math.max(MIN_FADE_S, Math.min(MAX_FADE_S, limit - end + FADE_LEAD_S))
    if (end - start > 0.2) segs.push({ start, end, fade })
  }
  return segs
}

/** Sort and merge overlapping segments (section starts + the lines after a seek). */
export function mergeSegments(segs: LeadSegment[]): LeadSegment[] {
  const sorted = [...segs].sort((a, b) => a.start - b.start)
  const out: LeadSegment[] = []
  for (const x of sorted) {
    const last = out.at(-1)
    if (last && x.start <= last.end) {
      if (x.end > last.end) {
        last.end = x.end
        last.fade = x.fade
      }
    } else out.push({ ...x })
  }
  return out
}

/** Lead-vocal segments (buffer seconds), snapped to the actual vocal when `activity` is known. */
export function leadSegments(lines: LyricLine[], activity: VocalActivity | null): LeadSegment[] {
  return segmentsFor(lines, leadLineIndexes(lines), activity)
}

/**
 * After a seek the singer has lost their place: the original vocal carries them back in. Landing
 * inside a line → the rest of that line and the next one; landing in a pause → the next line.
 */
export function seekLeadSegments(lines: LyricLine[], activity: VocalActivity | null, pos: number): LeadSegment[] {
  const ms = pos * 1000
  const i = currentLineIndex(lines, ms)
  const inLine = i >= 0 && ms < lineEnd(lines[i]!) - 300
  const indexes = inLine ? [i, i + 1] : [i + 1]
  const segs = segmentsFor(lines, indexes, activity)
  if (inLine && segs[0]) segs[0].start = Math.min(segs[0].start, Math.max(0, pos - 0.05))
  return segs
}
