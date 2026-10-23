import type { LyricLine, Lyrics } from '@shared/types'

/** Index of the line being sung at `ms` (the last line whose start <= ms), -1 before the first line. */
export function currentLineIndex(lines: LyricLine[], ms: number): number {
  let lo = 0
  let hi = lines.length - 1
  let ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (lines[mid].t <= ms) {
      ans = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  return ans
}

/**
 * A pause at least this long starts a new section: its first line gets 领唱 (lib/leadVocal.ts)
 * and a countdown. Most pop songs only breathe 3–5 s between verse and chorus.
 */
export const SECTION_GAP_MS = 4000
/** At most this many countdown dots (one per second); fewer when the pause is short. */
export const COUNTDOWN_DOTS = 5
const MIN_COUNTDOWN_DOTS = 3

/** When a line is actually done being sung (end of its last word). */
export function lineEnd(line: LyricLine): number {
  const last = line.words.at(-1)
  return last ? last.t + last.d : line.t + line.d
}

/** Pause before line `i` (ms): from the end of the previous line, or from 0 for the first line. */
function gapBefore(lines: LyricLine[], i: number): number {
  return lines[i]!.t - (i > 0 ? lineEnd(lines[i - 1]!) : 0)
}

/** Lines that start a section: the first line, and every line after a pause ≥ SECTION_GAP_MS. */
export function sectionStarts(lines: LyricLine[]): number[] {
  const out: number[] = []
  for (let i = 0; i < lines.length; i++) if (i === 0 || gapBefore(lines, i) >= SECTION_GAP_MS) out.push(i)
  return out
}

/**
 * Countdown dots before section start `i`: one per second of the pause, keeping a second of quiet
 * after the previous line — 4 s → 3 dots, 5 s → 4, 6 s or more → 5. 0 = too short for a countdown.
 */
export function countdownDots(lines: LyricLine[], i: number): number {
  const n = Math.min(COUNTDOWN_DOTS, Math.floor(gapBefore(lines, i) / 1000) - 1)
  return n >= MIN_COUNTDOWN_DOTS ? n : 0
}

/**
 * Countdown before the next section start: which line is about to start, how many dots are left
 * and how many it started with. Dots drop one per second and the last one disappears exactly
 * when the line starts. null when there is no countdown right now.
 */
export function interludeCountdown(lines: LyricLine[], ms: number): { index: number; dots: number; total: number } | null {
  const index = currentLineIndex(lines, ms) + 1
  const next = lines[index]
  if (!next) return null
  if (index > 0 && gapBefore(lines, index) < SECTION_GAP_MS) return null
  const total = countdownDots(lines, index)
  if (!total) return null
  const left = next.t - ms
  if (left <= 0 || left > total * 1000) return null
  return { index, dots: Math.ceil(left / 1000), total }
}

/** Fill percentage (0..100) for each word of a line at time `ms`. */
export function wordFills(line: LyricLine, ms: number): number[] {
  if (!line.words.length) {
    const p = line.d > 0 ? (ms - line.t) / line.d : ms >= line.t ? 1 : 0
    return [clamp01(p) * 100]
  }
  return line.words.map((w) => {
    if (ms <= w.t) return 0
    if (w.d <= 0 || ms >= w.t + w.d) return 100
    return ((ms - w.t) / w.d) * 100
  })
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n))

/** Words to render for a line (falls back to the whole text as one word). */
export function lineWords(line: LyricLine) {
  return line.words.length ? line.words : [{ t: line.t, d: line.d, text: line.text }]
}

export const hasLyrics = (l: Lyrics | undefined | null) => !!l && l.kind !== 'none' && l.lines.length > 0
