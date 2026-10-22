import type { LyricLine, LyricWord, Lyrics } from '../shared/types.js'

interface TimedText {
  t: number
  text: string
}

/** Lines like {"t":0,"c":[{"tx":"作词: "},{"tx":"xxx"}]} carry credits. */
function parseCreditLine(line: string): string | null {
  if (!line.startsWith('{')) return null
  try {
    const obj = JSON.parse(line) as { c?: { tx?: string }[] }
    const text = (obj.c ?? []).map((c) => c.tx ?? '').join('').trim()
    return text || null
  } catch {
    return null
  }
}

const LRC_TAG = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g

/** Parse an LRC string into timed lines (a line may carry several time tags). */
export function parseLrc(src: string | undefined, credits?: string[]): TimedText[] {
  if (!src) return []
  const out: TimedText[] = []
  for (const rawLine of src.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    const credit = parseCreditLine(line)
    if (credit !== null) {
      credits?.push(credit)
      continue
    }
    const times: number[] = []
    let last = 0
    LRC_TAG.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = LRC_TAG.exec(line))) {
      const frac = m[3] ?? '0'
      const ms = frac.length === 3 ? Number(frac) : frac.length === 2 ? Number(frac) * 10 : Number(frac) * 100
      times.push(Number(m[1]) * 60000 + Number(m[2]) * 1000 + ms)
      last = LRC_TAG.lastIndex
    }
    if (!times.length) continue
    const text = line.slice(last).trim()
    for (const t of times) out.push({ t, text })
  }
  return out.sort((a, b) => a.t - b.t)
}

const YRC_LINE = /^\[(\d+),(\d+)\](.*)$/
const YRC_WORD = /\((\d+),(\d+),\d+\)([^(]*)/g

/** Parse NetEase yrc (word-by-word) lyrics. All times are milliseconds. */
export function parseYrc(src: string | undefined, credits?: string[]): LyricLine[] {
  if (!src) return []
  const lines: LyricLine[] = []
  for (const rawLine of src.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    const credit = parseCreditLine(line)
    if (credit !== null) {
      credits?.push(credit)
      continue
    }
    const m = YRC_LINE.exec(line)
    if (!m) continue
    const words: LyricWord[] = []
    YRC_WORD.lastIndex = 0
    let w: RegExpExecArray | null
    while ((w = YRC_WORD.exec(m[3] ?? ''))) {
      words.push({ t: Number(w[1]), d: Number(w[2]), text: w[3] ?? '' })
    }
    const text = words.map((x) => x.text).join('')
    if (!text.trim()) continue
    lines.push({ t: Number(m[1]), d: Number(m[2]), text, words })
  }
  return lines.sort((a, b) => a.t - b.t)
}

const TOKEN = /[぀-ヿ㐀-鿿가-힯豈-﫿]|[^\s぀-ヿ㐀-鿿가-힯豈-﫿]+\s*|\s+/g

/** Split a line into karaoke tokens: one CJK char, or one latin word with its trailing space. */
export function tokenize(text: string): string[] {
  return text.match(TOKEN) ?? []
}

/** Build word timings for line-timed lyrics by spreading the line duration over its tokens. */
function interpolateWords(text: string, t: number, d: number): LyricWord[] {
  const tokens = tokenize(text)
  const weights = tokens.map((tok) => Math.max(1, tok.trim().length))
  const total = weights.reduce((a, b) => a + b, 0) || 1
  let cursor = t
  return tokens.map((tok, i) => {
    const wd = (d * (weights[i] ?? 1)) / total
    const word = { t: Math.round(cursor), d: Math.round(wd), text: tok }
    cursor += wd
    return word
  })
}

function lrcToLines(timed: TimedText[]): LyricLine[] {
  const lines: LyricLine[] = []
  for (let i = 0; i < timed.length; i++) {
    const cur = timed[i]!
    if (!cur.text) continue
    const next = timed[i + 1]
    const d = Math.min(next ? next.t - cur.t : 5000, 10000)
    // Sing over ~90% of the gap so the fill finishes before the next line.
    lines.push({ t: cur.t, d, text: cur.text, words: interpolateWords(cur.text, cur.t, d * 0.9) })
  }
  return lines
}

/** Attach translation / romanization lines to the nearest lyric line. */
function attach(lines: LyricLine[], extra: TimedText[], key: 'translation' | 'roma'): void {
  if (!extra.length) return
  for (const line of lines) {
    let best: TimedText | undefined
    let bestGap = Infinity
    for (const e of extra) {
      const gap = Math.abs(e.t - line.t)
      if (gap < bestGap) {
        bestGap = gap
        best = e
      }
    }
    if (best && bestGap <= 1500 && best.text) line[key] = best.text
  }
}

/** Normalize the `lyric_new` response into the shared Lyrics shape. */
export function buildLyrics(body: any): Lyrics {
  const credits: string[] = []
  const yrc = parseYrc(body?.yrc?.lyric, credits)
  let kind: Lyrics['kind'] = 'none'
  let lines: LyricLine[] = []
  if (yrc.length) {
    kind = 'yrc'
    lines = yrc
    parseLrc(body?.lrc?.lyric) // credits already taken from yrc
  } else {
    const lrc = parseLrc(body?.lrc?.lyric, credits)
    lines = lrcToLines(lrc)
    if (lines.length) kind = 'lrc'
  }
  attach(lines, parseLrc(body?.ytlrc?.lyric || body?.tlyric?.lyric), 'translation')
  attach(lines, parseLrc(body?.yromalrc?.lyric || body?.romalrc?.lyric), 'roma')
  // Drop pure credit lines that some songs put inside the timed lyrics, e.g. "作词 : xxx".
  const creditLike = /^(作词|作曲|编曲|制作人|演唱|原唱|混音|和声|吉他|贝斯|鼓|录音|母带|监制|出品|发行)\s*[:：]/
  lines = lines.filter((l) => {
    if (l.t < 30000 && creditLike.test(l.text)) {
      credits.push(l.text)
      return false
    }
    return true
  })
  if (!lines.length) kind = 'none'
  return { kind, lines, credits: [...new Set(credits)] }
}
