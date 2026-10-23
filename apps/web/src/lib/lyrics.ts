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

/** A gap at least this long between two sung lines (or before the first line) is an intro / interlude. */
export const INTERLUDE_MIN_GAP_MS = 8000
/** The countdown runs over the last 5 s of an interlude: one dot per second. */
export const COUNTDOWN_DOTS = 5

/** When the previous line is actually done being sung (end of its last word). */
function lineEnd(line: LyricLine): number {
  const last = line.words.at(-1)
  return last ? last.t + last.d : line.t + line.d
}

/**
 * Countdown before the line that follows a long gap: which line is about to start and how many
 * dots (5..1) are left. Dots drop one per second and the last one disappears exactly when the
 * line starts. null when there is no countdown right now.
 */
export function interludeCountdown(lines: LyricLine[], ms: number): { index: number; dots: number } | null {
  const idx = currentLineIndex(lines, ms)
  const index = idx + 1
  const next = lines[index]
  if (!next) return null
  const prevEnd = idx >= 0 ? lineEnd(lines[idx]!) : 0
  if (next.t - prevEnd < INTERLUDE_MIN_GAP_MS) return null
  const left = next.t - ms
  if (left <= 0 || left > COUNTDOWN_DOTS * 1000) return null
  return { index, dots: Math.ceil(left / 1000) }
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
