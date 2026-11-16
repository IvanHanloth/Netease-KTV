import type { LyricLine, Lyrics } from '../shared/types.js'

/**
 * Lyrics as an ASS subtitle file for the 录制 lyrics video (1280×720), burnt in with ffmpeg's
 * subtitles filter. The line being sung in the middle with its words lighting up karaoke-style
 * (\kf, like on the 大屏), the previous and next lines dimmed above and below, song and singer
 * in the top-left corner.
 */

/** A CJK font libass can find: Noto Sans CJK in the Docker image, 微软雅黑 on Windows. */
export const ASS_FONT = process.env.LYRICS_FONT ?? (process.platform === 'win32' ? 'Microsoft YaHei' : 'Noto Sans CJK SC')

const W = 1280
const H = 720

// &HAABBGGRR: alpha 00 = opaque.
const WHITE = '&H00FFFFFF'
const DIM = '&H8CFFFFFF'
const ACCENT = '&H007E4DFF' // #FF4D7E
const SHADOW = '&H96000000'

function time(ms: number): string {
  const cs = Math.max(0, Math.round(ms / 10))
  const h = Math.floor(cs / 360000)
  const m = Math.floor((cs % 360000) / 6000)
  const s = Math.floor((cs % 6000) / 100)
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`
}

/** Text as ASS shows it literally (braces start override blocks, backslashes escapes). */
function esc(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').replace(/\\/g, '＼').replace(/\{/g, '｛').replace(/\}/g, '｝')
}

/** The line with \kf word timings (centiseconds); words fill from the secondary to the primary colour. */
function karaoke(line: LyricLine): string {
  if (!line.words.length) return esc(line.text)
  let out = ''
  let at = line.t
  for (const w of line.words) {
    const gap = Math.round((w.t - at) / 10)
    if (gap > 0) out += `{\\k${gap}}`
    out += `{\\kf${Math.max(1, Math.round(w.d / 10))}}${esc(w.text)}`
    at = w.t + w.d
  }
  return out
}

function header(): string {
  // Name, Fontname, Fontsize, Primary, Secondary, Outline, Back, Bold, Italic, Underline, StrikeOut,
  // ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
  const style = (name: string, size: number, primary: string, secondary: string, bold: number, align: number) =>
    `Style: ${name},${ASS_FONT},${size},${primary},${secondary},&H64000000,${SHADOW},${bold},0,0,0,100,100,1,0,1,0,2,${align},60,60,40,1`
  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${W}`,
    `PlayResY: ${H}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    style('Cur', 58, ACCENT, WHITE, 1, 5),
    style('Near', 38, DIM, DIM, 0, 5),
    style('Title', 30, WHITE, WHITE, 1, 7),
    style('Sub', 24, DIM, DIM, 0, 7),
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ].join('\n')
}

/** The ASS file for a recording; `durationMs` is the video's length (the title stays up until then). */
export function buildAss(lyrics: Lyrics, opts: { durationMs: number; title: string; subtitle: string }): string {
  const lines = lyrics.lines.filter((l) => l.text.trim())
  const ev: string[] = []
  const add = (start: number, end: number, style: string, text: string) => {
    if (end - start < 20) return
    ev.push(`Dialogue: 0,${time(start)},${time(end)},${style},,0,0,0,,${text}`)
  }
  const pos = (x: number, y: number) => `{\\pos(${x},${y})}`

  add(0, opts.durationMs, 'Title', pos(64, 52) + esc(opts.title))
  add(0, opts.durationMs, 'Sub', pos(64, 96) + esc(opts.subtitle))
  lines.forEach((line, i) => {
    const prev = lines[i - 1]
    const next = lines[i + 1]
    // A line stays up until the next one starts, but not through a long instrumental break.
    const end = Math.min(next ? next.t : opts.durationMs, line.t + Math.max(line.d, 0) + 4000, opts.durationMs)
    if (end <= line.t) return
    if (prev) add(line.t, end, 'Near', pos(W / 2, 250) + esc(prev.text))
    add(line.t, end, 'Cur', pos(W / 2, 360) + karaoke(line))
    if (next) add(line.t, end, 'Near', pos(W / 2, 470) + esc(next.text))
  })
  // Before the first line: show it dimmed, so the singer sees what is coming.
  const first = lines[0]
  if (first && first.t > 1500) add(Math.max(0, first.t - 5000), first.t, 'Near', pos(W / 2, 360) + esc(first.text))
  return header() + '\n' + ev.join('\n') + '\n'
}

export const hasTimedLyrics = (l: Lyrics | null | undefined): l is Lyrics => !!l && l.kind !== 'none' && l.lines.some((x) => x.text.trim())
