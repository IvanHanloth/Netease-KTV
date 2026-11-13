import { useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import type { QueueItem, Song } from '@shared/types'
import { artistsText } from '../lib/format'
import { rating, type RatingTone } from '../player/scoring'
import type { LineRating } from '../player/useScoring'
import { useApp } from '../store/app'
import { Cover } from './ui'

export const toneGradient: Record<RatingTone, string> = {
  perfect: 'linear-gradient(90deg, #FFB547 0%, #FF4D7E 100%)',
  great: 'linear-gradient(90deg, #FF4D7E 0%, #8B6CFF 100%)',
  good: 'linear-gradient(90deg, #22D3EE 0%, #8B6CFF 100%)',
  try: 'linear-gradient(90deg, #E4E4EA 0%, #A1A1AA 100%)',
}

const gradientText = (tone: RatingTone) => ({
  backgroundImage: toneGradient[tone],
  WebkitBackgroundClip: 'text' as const,
  backgroundClip: 'text' as const,
  color: 'transparent',
})

/** Short per-line rating that pops near the lyrics. */
export function LineRatingPop({ rating: r }: { rating: LineRating | null }) {
  const reduce = useReducedMotion()
  const [shown, setShown] = useState<LineRating | null>(null)
  useEffect(() => {
    if (!r) return
    setShown(r)
    const t = setTimeout(() => setShown((s) => (s?.id === r.id ? null : s)), 1400)
    return () => clearTimeout(t)
  }, [r])
  return (
    <div className="pointer-events-none absolute top-[21vh] left-1/2 z-10 -translate-x-1/2" aria-live="polite">
      <AnimatePresence>
        {shown && (
          <motion.div
            key={shown.id}
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: 14, scale: 0.8 }}
            animate={reduce ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, y: -16, scale: 1.08 }}
            transition={{ type: 'spring', stiffness: 420, damping: 26 }}
            className="flex items-baseline gap-3"
          >
            <span
              className="text-[clamp(28px,2.6vw,52px)] font-black tracking-[0.06em] italic drop-shadow-[0_6px_24px_rgba(255,77,126,0.45)]"
              style={gradientText(shown.tone)}
            >
              {shown.label}
            </span>
            <span className="num text-[clamp(16px,1.2vw,24px)] font-semibold text-white/70">{Math.round(shown.score)}</span>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

export interface ScoreResult {
  id: number
  score: number
  song: Song
  tolerance: number
  singer?: string
  /** Filled in once the leaderboard confirms the score. */
  rank?: number
  best?: number
  plays?: number
}

function CountUp({ to, run }: { to: number; run: boolean }) {
  const [v, setV] = useState(run ? 0 : to)
  useEffect(() => {
    if (!run) {
      setV(to)
      return
    }
    let raf = 0
    const start = performance.now()
    const step = (now: number) => {
      const p = Math.min(1, (now - start) / 1200)
      setV(to * (1 - Math.pow(1 - p, 3)))
      if (p < 1) raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [to, run])
  return <>{Math.round(v)}</>
}

const SHOW_MS = 4500

/** Three dots that light up one by one while the result is on screen (the next song starts after). */
function CountdownDots({ run }: { run: boolean }) {
  const [lit, setLit] = useState(run ? 1 : 3)
  useEffect(() => {
    if (!run) return
    const ts = [1, 2].map((i) => window.setTimeout(() => setLit(i + 1), (SHOW_MS / 3) * i))
    return () => ts.forEach((t) => window.clearTimeout(t))
  }, [run])
  return (
    <span className="flex shrink-0 gap-[1.1vh]" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className={'h-[1.7vh] w-[1.7vh] rounded-full transition-colors duration-300 ' + (i < lit ? 'bg-accent' : 'bg-white/20')}
        />
      ))}
    </span>
  )
}

/**
 * End-of-song result screen: the score, then 即将开始 with the next song in the queue.
 * Purely visual: never blocks playback or the next song.
 */
export function ScoreOverlay({ result, onDone }: { result: ScoreResult | null; onDone: () => void }) {
  const reduce = useReducedMotion()
  const id = result?.id
  useEffect(() => {
    if (id === undefined) return
    const t = setTimeout(onDone, SHOW_MS)
    return () => clearTimeout(t)
  }, [id, onDone])
  // The song after the one just scored: the head of the queue at the moment the result appears.
  const next = useMemo<QueueItem | null>(() => (id === undefined ? null : (useApp.getState().state.queue[0] ?? null)), [id])
  const r = result ? rating(result.score) : null
  return (
    <AnimatePresence>
      {result && r && (
        <motion.div
          key={result.id}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.4 }}
          className="pointer-events-none absolute inset-0 z-30 overflow-hidden bg-[#07070B]/95"
          role="status"
          aria-live="polite"
        >
          <span
            aria-hidden="true"
            className="absolute top-[46%] left-1/2 h-[92vh] w-[78vw] -translate-x-1/2 -translate-y-1/2 rounded-full"
            style={{ background: 'radial-gradient(ellipse, rgba(255,77,126,0.22) 0%, rgba(255,77,126,0) 62%)' }}
          />

          <motion.section
            aria-label="本曲得分"
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: 30, scale: 0.94 }}
            animate={reduce ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1 }}
            transition={{ type: 'spring', stiffness: 260, damping: 24 }}
            className="absolute top-[10vh] left-1/2 flex w-[52vw] -translate-x-1/2 flex-col items-center gap-[1.7vh] text-center"
          >
            <div className="flex items-center gap-[1.7vh]">
              <Cover song={result.song} px={160} className="h-[6.7vh] w-[6.7vh] shrink-0 rounded-[1.7vh]" />
              <div className="flex min-w-0 flex-col items-start gap-[0.4vh]">
                <span className="text-[2vh] tracking-[0.2em] text-fg-2">本曲得分</span>
                <span className="max-w-[40vw] truncate text-[2.6vh] font-extrabold">
                  {result.song.name} · {artistsText(result.song)}
                </span>
              </div>
            </div>
            <div
              className="num text-[27.8vh] leading-[0.95] font-black tracking-[-0.02em] text-white tabular-nums"
              style={{ textShadow: '0 20px 80px rgba(255,77,126,0.55)' }}
            >
              <CountUp to={result.score} run={!reduce} />
            </div>
            <div className="flex items-center gap-[1.7vh]">
              <span className="num text-[5.9vh] font-black tracking-[0.12em] text-accent">{r.label}</span>
              {result.rank === 1 && (result.plays ?? 0) > 1 && (
                <span className="inline-flex h-[4.8vh] items-center rounded-full bg-[#FBBF24] px-[2vh] text-[2.4vh] font-black whitespace-nowrap text-[#2A1A00]">
                  新纪录
                </span>
              )}
            </div>
            {result.rank !== undefined && (
              <motion.span
                initial={reduce ? { opacity: 0 } : { opacity: 0, y: 10 }}
                animate={reduce ? { opacity: 1 } : { opacity: 1, y: 0 }}
                transition={{ duration: 0.35 }}
                className="text-[2.8vh] whitespace-nowrap text-fg-2"
              >
                {result.singer ? `${result.singer} · ` : ''}本曲第 <span className="num font-extrabold">{result.rank}</span> 名 · 最高{' '}
                <span className="num font-extrabold">{Math.round(result.best ?? result.score)}</span> 分
              </motion.span>
            )}
          </motion.section>

          {next && (
            <motion.section
              aria-label="即将开始"
              initial={reduce ? { opacity: 0 } : { opacity: 0, y: 24 }}
              animate={reduce ? { opacity: 1 } : { opacity: 1, y: 0 }}
              transition={{ duration: 0.45, delay: reduce ? 0 : 0.5 }}
              className="absolute bottom-[8.9vh] left-1/2 flex w-[54vw] -translate-x-1/2 items-center gap-[2.6vh] rounded-[3.3vh] border border-white/12 bg-white/6 py-[2.4vh] pr-[3.3vh] pl-[2.4vh]"
            >
              <Cover song={next.song} px={240} className="h-[11vh] w-[11vh] shrink-0 rounded-[2.2vh]" />
              <span className="flex min-w-0 grow flex-col gap-[0.7vh]">
                <span className="text-[2vh] tracking-[0.2em] text-accent-soft">即将开始</span>
                <span className="truncate text-[4.1vh] font-black">{next.song.name}</span>
                <span className="truncate text-[2.4vh] text-fg-2">
                  {artistsText(next.song)}
                  {next.addedBy && (
                    <>
                      {' '}
                      · 演唱：<span className="font-bold text-fg">{next.addedBy}</span>，请拿起麦克风
                    </>
                  )}
                </span>
              </span>
              <CountdownDots run={!reduce} />
            </motion.section>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  )
}
