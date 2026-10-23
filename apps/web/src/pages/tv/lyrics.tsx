import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AnimatePresence, motion } from 'motion/react'
import clsx from 'clsx'
import type { LyricLine, Song } from '@shared/types'
import { api } from '../../lib/api'
import { currentLineIndex, hasLyrics, interludeCountdown, lineWords, wordFills } from '../../lib/lyrics'
import { Cover } from '../../components/ui'

/** 大屏 lyrics: stage lyrics (four lines) and two-row KTV lyrics over MV, word fill painted per frame. */

export const reduceMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

/**
 * Something derived from the playback clock, recomputed every frame but only re-rendered when it
 * changes (`key` decides what counts as a change). Lyrics change line a few times a minute; the
 * per-frame word fill is painted directly by CurrentLine / KtvLine, not through React.
 */
export function useTicked<T>(getMs: () => number, active: boolean, compute: (ms: number) => T, key: (v: T) => string): T {
  const [value, setValue] = useState(() => compute(getMs()))
  const computeRef = useRef(compute)
  computeRef.current = compute
  const keyRef = useRef(key)
  keyRef.current = key
  useEffect(() => {
    if (!active) return
    let raf = 0
    let last = ''
    const tick = () => {
      const v = computeRef.current(getMs())
      const k = keyRef.current(v)
      if (k !== last) {
        last = k
        setValue(v)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [getMs, active])
  return value
}

/** Paint a line's word fills every frame, straight onto the word elements. */
export function useWordFills(line: LyricLine, getMs: () => number, paint: (el: HTMLElement, p: number) => void) {
  const refs = useRef<(HTMLElement | null)[]>([])
  const paintRef = useRef(paint)
  paintRef.current = paint
  useEffect(() => {
    let raf = 0
    const last: number[] = []
    const tick = () => {
      const fills = wordFills(line, getMs())
      fills.forEach((f, i) => {
        const p = Math.round(f * 10) / 10
        const el = refs.current[i]
        if (el && last[i] !== p) {
          last[i] = p
          paintRef.current(el, p)
        }
      })
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [line, getMs])
  return refs
}

export function useLyrics(songId: number) {
  return useQuery({ queryKey: ['lyrics', songId], queryFn: () => api.lyrics(songId), staleTime: Infinity })
}

/**
 * Countdown shown above the first line of a section (3–5 dots, see lib/lyrics.ts), the
 * rightmost one disappearing each second, the last one vanishing exactly as the line begins.
 * Absolutely positioned so it never shifts the lyrics.
 */
export function CountdownDots({ dots, total, align = 'center' }: { dots: number; total: number; align?: 'center' | 'left' | 'right' }) {
  return (
    <div
      aria-hidden="true"
      className={clsx(
        'pointer-events-none absolute bottom-full mb-[0.4em] flex gap-[0.5em]',
        align === 'center' && 'left-1/2 -translate-x-1/2',
        align === 'left' && 'left-0',
        align === 'right' && 'right-0',
      )}
    >
      {Array.from({ length: total }, (_, i) => {
        // Dots disappear from right to left: the rightmost one goes first.
        const on = i < dots
        return (
          <span
            key={i}
            className="block h-[0.5em] w-[0.5em] rounded-full bg-accent transition-[opacity,transform] duration-300 motion-reduce:transition-none"
            style={{
              opacity: on ? 1 : 0,
              transform: on ? 'scale(1)' : 'scale(0.3)',
              boxShadow: on ? '0 0 0.4em rgba(255,77,126,0.85), 0 0 0 0.06em rgba(8,8,12,0.6)' : 'none',
            }}
          />
        )
      })}
    </div>
  )
}

export const paintStage = (el: HTMLElement, p: number) => {
  el.style.backgroundImage = `linear-gradient(90deg, #FFFFFF ${p}%, rgba(255,255,255,0.34) ${p}%)`
  el.style.filter = p >= 100 ? 'drop-shadow(0 0 22px rgba(255,77,126,0.75))' : 'none'
}

export const notStarted = () => -1

/** The big line in stage mode. `started` false: the line is shown but not sung yet (intro). */
export function CurrentLine({
  line,
  getMs,
  started,
  showTranslation,
}: {
  line: LyricLine
  getMs: () => number
  started: boolean
  showTranslation: boolean
}) {
  const words = lineWords(line)
  const refs = useWordFills(line, started ? getMs : notStarted, paintStage)
  return (
    <div className="flex flex-col items-center gap-[2vh]">
      <p className="m-0 px-[4vw] text-[clamp(40px,4.8vw,104px)] leading-[1.15] font-black tracking-[0.04em]">
        {words.map((w, i) => (
          <span
            key={i}
            ref={(el) => {
              refs.current[i] = el
            }}
            style={{
              backgroundImage: 'linear-gradient(90deg, #FFFFFF 0%, rgba(255,255,255,0.34) 0%)',
              WebkitBackgroundClip: 'text',
              backgroundClip: 'text',
              color: 'transparent',
              whiteSpace: 'pre-wrap',
            }}
          >
            {w.text}
          </span>
        ))}
      </p>
      {showTranslation && (line.translation || line.roma) && (
        <p className="num m-0 px-[4vw] text-[clamp(18px,1.45vw,32px)] tracking-[0.02em] text-[#C8C8D0]">
          {line.translation || line.roma}
        </p>
      )}
    </div>
  )
}

/** Cover + title for songs without (loadable) lyrics. */
export function NoLyrics({ song, message }: { song: Song; message: string }) {
  return (
    <div className="flex flex-col items-center gap-6 text-center">
      <Cover song={song} px={600} className="h-[30vh] w-[30vh] rounded-[28px] shadow-[0_30px_80px_rgba(0,0,0,0.5)]" />
      <div className="flex flex-col gap-2">
        <p className="m-0 text-[clamp(36px,3.6vw,72px)] font-black">{song.name}</p>
        <p className="m-0 text-[clamp(16px,1.3vw,26px)] text-muted">{message}</p>
      </div>
    </div>
  )
}

/** Viewport too short for the full four-line stage (≈ 720p and below). */
export function useShortViewport() {
  const [short, setShort] = useState(() => window.innerHeight < 820)
  useEffect(() => {
    const on = () => setShort(window.innerHeight < 820)
    window.addEventListener('resize', on)
    return () => window.removeEventListener('resize', on)
  }, [])
  return short
}

export const countdownKey = (c: ReturnType<typeof interludeCountdown>) => (c ? `${c.index}:${c.dots}:${c.total}` : '-')

/**
 * Stage lyrics: previous, current (big, filled word by word), next and next-next lines.
 * `compact` (scoring lane on) and short screens drop outer lines so nothing overflows.
 */
export function LyricsView({ songId, getMs, song, compact }: { songId: number; getMs: () => number; song: Song; compact: boolean }) {
  const { data, isError } = useLyrics(songId)
  const short = useShortViewport()
  const lines = data?.lines ?? []
  const state = useTicked(
    getMs,
    hasLyrics(data),
    (ms) => ({ idx: currentLineIndex(lines, ms), countdown: interludeCountdown(lines, ms) }),
    (v) => `${v.idx}|${countdownKey(v.countdown)}`,
  )
  // A failed background refetch keeps `data`: only a first load that failed shows the error.
  if (!data) return isError ? <NoLyrics song={song} message="歌词加载失败，尽情发挥吧" /> : null
  if (!hasLyrics(data)) return <NoLyrics song={song} message="这首歌暂无歌词，尽情发挥吧" />
  const { idx, countdown } = state
  const cur = Math.max(0, idx)
  const prev = idx > 0 ? lines[idx - 1] : null
  const next1 = lines[cur + 1]
  const next2 = lines[cur + 2]
  const showTranslation = lines.some((l) => l.translation || l.roma)
  const showPrev = !(compact && short)
  const showNext2 = !compact && !short
  return (
    <div className="flex w-full flex-col items-center gap-[2.8vh] text-center">
      <AnimatePresence mode="popLayout" initial={false}>
        {showPrev && (
          <motion.p
            key={'p' + (idx - 1)}
            layout
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -30 }}
            transition={{ duration: 0.35 }}
            className="m-0 min-h-[1.2em] px-[4vw] text-[clamp(22px,2.1vw,44px)] font-medium text-white/40"
          >
            {prev?.text ?? ' '}
          </motion.p>
        )}
        <motion.div
          key={'c' + cur}
          layout
          initial={{ opacity: 0, y: 40, scale: 0.94 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -40, scale: 0.92 }}
          transition={{ duration: 0.4 }}
          className="relative my-[1.5vh] text-[clamp(40px,4.8vw,104px)]"
        >
          {/* Intro: the first line is the big line and the one about to start. */}
          {countdown?.index === cur && <CountdownDots dots={countdown.dots} total={countdown.total} />}
          <CurrentLine line={lines[cur]!} getMs={getMs} started={idx >= 0} showTranslation={showTranslation} />
        </motion.div>
        <motion.p
          key={'n' + (cur + 1)}
          layout
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -30 }}
          transition={{ duration: 0.35 }}
          className="relative m-0 min-h-[1.2em] px-[4vw] text-[clamp(24px,2.4vw,50px)] font-semibold text-white/62"
        >
          {/* Interlude: the next line is the one about to start. */}
          {countdown && countdown.index === cur + 1 && <CountdownDots dots={countdown.dots} total={countdown.total} />}
          {next1?.text ?? ' '}
        </motion.p>
        {showNext2 && (
          <motion.p
            key={'m' + (cur + 2)}
            layout
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.35 }}
            className="m-0 min-h-[1.2em] px-[4vw] text-[clamp(20px,1.9vw,40px)] font-medium text-white/38"
          >
            {next2?.text ?? ' '}
          </motion.p>
        )}
      </AnimatePresence>
    </div>
  )
}

export const paintKtv = (el: HTMLElement, p: number) => {
  el.style.backgroundImage = `linear-gradient(90deg, #FF6B9A ${p}%, #FFFFFF ${p}%)`
}

/** One KTV-style line over video: white text, pink fill as it is sung, dark outline for legibility. */
export function KtvLine({ line, getMs }: { line: LyricLine; getMs: () => number }) {
  const words = lineWords(line)
  const refs = useWordFills(line, getMs, paintKtv)
  return (
    <p className="m-0 max-w-[88vw] leading-[1.22] font-black tracking-[0.03em]">
      {words.map((w, i) => (
        // Two layers per word: a dark outline (with its shadow, painted once) underneath and the
        // coloured fill on top. A stroke drawn on the fill itself would eat thin CJK strokes.
        <span key={i} className="relative inline-block" style={{ whiteSpace: 'pre' }}>
          <span
            aria-hidden="true"
            className="absolute inset-0"
            style={{ color: 'transparent', WebkitTextStroke: '0.12em rgba(8,8,12,0.9)', textShadow: '0 3px 12px rgba(0,0,0,0.85)' }}
          >
            {w.text}
          </span>
          <span
            ref={(el) => {
              refs.current[i] = el
            }}
            className="relative"
            style={{
              backgroundImage: 'linear-gradient(90deg, #FF6B9A 0%, #FFFFFF 0%)',
              WebkitBackgroundClip: 'text',
              backgroundClip: 'text',
              color: 'transparent',
            }}
          >
            {w.text}
          </span>
        </span>
      ))}
    </p>
  )
}

/**
 * Classic two-row KTV lyrics: even lines on the upper row (left-aligned), odd lines on
 * the lower row (right-aligned). The row being sung fills word by word while the other
 * row shows the upcoming line; once a line is done its row is replaced by the next-next one.
 * `raised` (controls shown) lifts the rows just clear of the control bar.
 */
export function TwoLineLyrics({ songId, getMs, raised }: { songId: number; getMs: () => number; raised: boolean }) {
  const { data } = useLyrics(songId)
  const lines = data?.lines ?? []
  const state = useTicked(
    getMs,
    hasLyrics(data),
    (ms) => {
      const idx = currentLineIndex(lines, ms)
      let base = Math.max(0, idx)
      if (idx >= 0) {
        const l = lines[idx]!
        if (ms > l.t + l.d + 400 && idx + 1 < lines.length) base = idx + 1 // finished: bring in the next pair early
      }
      return { base, countdown: interludeCountdown(lines, ms) }
    },
    (v) => `${v.base}|${countdownKey(v.countdown)}`,
  )
  if (!data || !hasLyrics(data)) return null
  const { base, countdown } = state
  const rows: (number | undefined)[] = [undefined, undefined]
  for (const i of [base, base + 1]) if (i < lines.length) rows[i % 2] = i
  return (
    <div
      className={clsx(
        'pointer-events-none absolute inset-x-[5vw] flex flex-col gap-[1.4vh] text-[clamp(30px,3.5vw,76px)] transition-[bottom] duration-500 motion-reduce:transition-none',
        raised ? 'bottom-[calc(5.2vh+140px)]' : 'bottom-[12vh]',
      )}
    >
      {rows.map((li, r) => (
        <div key={r} className={clsx('flex min-h-[1.25em]', r === 0 ? 'justify-start text-left' : 'justify-end text-right')}>
          <AnimatePresence mode="wait" initial={false}>
            {li !== undefined && (
              <motion.div
                key={li}
                initial={{ opacity: 0, y: 14 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                transition={{ duration: reduceMotion() ? 0 : 0.25 }}
                className="relative"
              >
                {countdown?.index === li && <CountdownDots dots={countdown.dots} total={countdown.total} align={r === 0 ? 'left' : 'right'} />}
                <KtvLine line={lines[li]!} getMs={getMs} />
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      ))}
    </div>
  )
}
