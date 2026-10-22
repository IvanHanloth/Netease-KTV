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
