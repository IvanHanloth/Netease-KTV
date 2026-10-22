import { useEffect, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import type { Song } from '@shared/types'
import { artistsText } from '../lib/format'
import { rating, type RatingTone } from '../player/scoring'
import type { LineRating } from '../player/useScoring'
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

/** End-of-song result card. Purely visual: never blocks playback or the next song. */
export function ScoreOverlay({ result, onDone }: { result: ScoreResult | null; onDone: () => void }) {
  const reduce = useReducedMotion()
  useEffect(() => {
    if (!result) return
    const t = setTimeout(onDone, 6000)
    return () => clearTimeout(t)
  }, [result, onDone])
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
          className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-ink-2/55 backdrop-blur-sm"
          role="status"
          aria-live="polite"
        >
          <motion.div
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: 30, scale: 0.92 }}
            animate={reduce ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1 }}
            transition={{ type: 'spring', stiffness: 260, damping: 24 }}
            className="glass flex flex-col items-center gap-5 rounded-[36px] px-[5vw] py-[5vh] text-center shadow-[0_40px_120px_rgba(0,0,0,0.55)]"
          >
            <div className="flex items-center gap-4">
              <Cover song={result.song} px={160} className="h-16 w-16 rounded-2xl" />
              <div className="flex min-w-0 flex-col items-start gap-1">
                <span className="text-sm tracking-[0.14em] text-muted">本曲得分</span>
                <span className="max-w-[36vw] truncate text-[clamp(18px,1.4vw,28px)] font-bold">
                  {result.song.name} · <span className="font-normal text-fg-2">{artistsText(result.song)}</span>
                </span>
              </div>
            </div>
            <div className="num text-[clamp(96px,11vw,200px)] leading-none font-black tabular-nums" style={gradientText(r.tone)}>
              <CountUp to={result.score} run={!reduce} />
            </div>
            <div className="text-[clamp(28px,2.6vw,52px)] font-black tracking-[0.08em] italic" style={gradientText(r.tone)}>
              {r.label}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
