import { useEffect, useRef, useState } from 'react'
import { motion } from 'motion/react'
import type { EarPlayer } from '../player/earPlayer'
import { Icon } from './icons'

/**
 * 蓝牙延迟校准 for 移动耳返: a live adjustment, not a scored test.
 *
 * A beep leaves the phone once a second, on a fixed beat. An outer ring shrinks through the inner
 * circle once a second as well, crossing it `latency` ms after each beep leaves (and carrying on
 * inside, so the crossing is a clean moment rather than a stop). The user taps along with the
 * beeps as they *hear* them. Every tap sets the delay to (tap − the beat its beep left on): the
 * crossing moves onto the moment the beep was heard. So when the delay is right, the crossing is
 * seen exactly as the beep is heard; the user checks that and presses 结束测试, then is asked
 * whether to use the value as the 耳返 delay.
 *
 * Tapping along with the beat is what makes the measurement work: a tap on the crossing itself
 * would only measure the finger. The copy says so.
 */

const PERIOD_MS = 1000
/** Starting delay the first time (a typical Bluetooth headset). */
export const FIRST_GUESS_MS = 200
const DEFAULT_MAX_MS = 800
/**
 * A tap this far *before* a beat still belongs to that beat, not the previous one: people tapping
 * along a rhythm run a little early, and a Bluetooth delay close to a whole period is not a thing.
 */
const EARLY_MS = 150
/** Beeps are put on the audio clock this far ahead. */
const LOOKAHEAD_MS = 1800

/** Ring geometry in viewBox units: the inner circle's radius, and the ring's first / last radius. */
const R_INNER = 30
const R_FROM = 48
const R_TO = 12
/** The inner circle lights up for this fraction of a period after each crossing. */
const FLASH = 0.12

type Phase = 'intro' | 'running' | 'confirm'

/**
 * The event's own timestamp, set when the input arrived, before any handler delay: on the
 * performance.now() clock in current engines. (A wall-clock value from an old engine is far from
 * performance.now(); fall back to now.)
 */
const eventTime = (e: { timeStamp: number }) => {
  const now = performance.now()
  return Math.abs(e.timeStamp - now) < 60_000 ? e.timeStamp : now
}

export function LatencyCalibration({
  ear,
  initialLatencyMs,
  maxLatencyMs = DEFAULT_MAX_MS,
  onApply,
  onClose,
}: {
  ear: EarPlayer
  /** Where the adjustment starts (ms the headset is late). */
  initialLatencyMs: number
  /** Largest delay the result may take. */
  maxLatencyMs?: number
  /** Use `latencyMs` as the 耳返 delay. */
  onApply: (latencyMs: number) => void
  onClose: () => void
}) {
  const clamp = (ms: number) => Math.max(0, Math.min(maxLatencyMs, ms))
  const [phase, setPhase] = useState<Phase>('intro')
  const [latency, setLatency] = useState(() => Math.round(clamp(initialLatencyMs)))
  // Read by the animation frame; written on tap, before React re-renders.
  const latencyRef = useRef(latency)
  const [flash, setFlash] = useState(0)
  const ringRef = useRef<SVGCircleElement>(null)
  const coreRef = useRef<SVGCircleElement>(null)
  /** The run: performance.now() time its first beep leaves the phone. Beat k leaves at t0 + k·PERIOD. */
  const beatRef = useRef<{ t0: number } | null>(null)

  // ---- the run: a beep per second on a fixed beat, and the ring crossing `latency` after each ----
  useEffect(() => {
    if (phase !== 'running') return
    const ctx = ear.ctx
    if (!ctx) return
    const t0 = performance.now() + PERIOD_MS // the ring approaches for a second before the first beep
    beatRef.current = { t0 }

    // Keep beeps queued on the audio clock LOOKAHEAD ahead. They never depend on the delay, so a
    // tap moves the ring at once rather than the next beep later.
    let queued = 0
    const cancels: (() => void)[] = []
    const queue = () => {
      const now = performance.now()
      while (t0 + queued * PERIOD_MS < now + LOOKAHEAD_MS) {
        const at = ear.ctxOf(t0 + queued * PERIOD_MS)
        cancels.push(ear.beep(Math.max(ctx.currentTime + 0.01, at)))
        queued++
      }
    }
    queue()
    const timer = window.setInterval(queue, 200)

    // The ring: shrinks at a steady pace from outside the inner circle to well inside it, crossing
    // it `latency` ms after each beat; the inner circle flashes at the crossing.
    let raf = 0
    const draw = (t: number) => {
      raf = requestAnimationFrame(draw)
      const ring = ringRef.current
      const core = coreRef.current
      if (!ring || !core) return
      const x = (t - t0 - latencyRef.current) / PERIOD_MS
      const p = x - Math.round(x) // in [-0.5, 0.5): 0 at the crossing, negative = still outside
      ring.setAttribute('r', String(R_INNER - (R_FROM - R_TO) * p))
      ring.setAttribute('opacity', String(1 - (2 * p) ** 4)) // in from nothing, out to nothing
      core.setAttribute('fill-opacity', String(p >= 0 && p < FLASH ? 0.4 * (1 - p / FLASH) : 0))
    }
    raf = requestAnimationFrame(draw)
    return () => {
      window.clearInterval(timer)
      cancelAnimationFrame(raf)
      for (const cancel of cancels) cancel()
      beatRef.current = null
    }
  }, [phase, ear])

  async function start() {
    await ear.unlock()
    if (!ear.ctx) return
    setPhase('running')
  }

  /** A tap at performance.now() time `time`: the delay becomes its distance from the beat it followed. */
  function tapAt(time: number) {
    const run = beatRef.current
    if (!run) return
    const k = Math.floor((time - run.t0 + EARLY_MS) / PERIOD_MS)
    if (k < 0) return // before the first beep
    const ms = Math.round(clamp(time - (run.t0 + k * PERIOD_MS)))
    latencyRef.current = ms
    setLatency(ms)
    setFlash((n) => n + 1)
  }

  function onPointerDown(e: React.PointerEvent) {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    tapAt(eventTime(e))
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.repeat || (e.key !== ' ' && e.key !== 'Enter')) return
    e.preventDefault() // no click after it, so the tap is counted once
    tapAt(eventTime(e))
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="测量蓝牙延迟"
      className="fixed inset-0 z-50 flex flex-col bg-ink/95 px-6 pt-[max(16px,env(safe-area-inset-top))] pb-[max(24px,env(safe-area-inset-bottom))] text-fg backdrop-blur-md"
    >
      <span className="pt-2 text-center text-[15px] font-semibold">测量蓝牙延迟</span>

      {phase === 'intro' && (
        <div className="m-auto flex w-full max-w-sm flex-col items-center gap-6 text-center">
          <span className="flex h-20 w-20 items-center justify-center rounded-[24px] bg-white/8 text-accent-soft">
            <Icon name="headphones" size={38} />
          </span>
          <p className="m-0 text-[15px] leading-7 text-fg-2">
            戴上耳机。开始后每秒响一声“嘀”，每听到一声就点一下。
            <br />
            圆圈相交的时刻会跟着你的点击走；当相交和“嘀”同时发生，延迟就对了。
          </p>
          <div className="flex w-full flex-col gap-3">
            <button
              type="button"
              onClick={start}
              className="flex h-14 w-full items-center justify-center gap-2 rounded-2xl bg-accent text-[17px] font-bold text-accent-ink shadow-[0_14px_36px_rgba(255,77,126,0.4)]"
            >
              <Icon name="play" size={20} />
              开始
            </button>
            <button type="button" onClick={onClose} className="h-12 rounded-2xl text-[15px] text-muted">
              取消
            </button>
          </div>
        </div>
      )}

      {phase === 'running' && (
        <div className="m-auto flex w-full max-w-sm flex-col items-center gap-5">
          <div className="flex flex-col items-center gap-1">
            <span className="text-xs text-muted">当前延迟</span>
            <span className="num text-4xl font-black" aria-live="polite">
              {latency} <span className="text-lg font-semibold text-muted">ms</span>
            </span>
          </div>

          {/* The rings: the inner circle stays; the outer ring shrinks through it once a second. */}
          <div className="aspect-square w-[min(56vw,240px)]">
            <svg viewBox="0 0 100 100" className="h-full w-full overflow-visible" aria-hidden="true">
              <circle
                ref={coreRef}
                cx="50"
                cy="50"
                r={R_INNER}
                className="fill-accent-soft stroke-white/30"
                strokeWidth="0.8"
                fillOpacity="0"
              />
              <circle ref={ringRef} cx="50" cy="50" r={R_FROM} fill="none" className="stroke-accent-soft" strokeWidth="2" opacity="0" />
            </svg>
          </div>

          <p className="m-0 text-center text-[13px] leading-6 text-muted">
            相交的时刻会对齐到你点的时刻。
            <br />
            相交和“嘀”同时发生时，点“结束测试”。
          </p>

          <button
            type="button"
            onPointerDown={onPointerDown}
            onKeyDown={onKeyDown}
            aria-label="听到“嘀”就点这里"
            className="relative flex h-24 w-full touch-none items-center justify-center overflow-hidden rounded-3xl border border-white/10 bg-white/[0.06] text-xl font-black select-none active:bg-white/12"
          >
            听到“嘀”就点
            {/* Brief pulse on each tap. */}
            {flash > 0 && (
              <motion.span
                key={flash}
                aria-hidden="true"
                initial={{ opacity: 0.5 }}
                animate={{ opacity: 0 }}
                transition={{ duration: 0.35 }}
                className="pointer-events-none absolute inset-0 bg-accent/50"
              />
            )}
          </button>

          <button
            type="button"
            onClick={() => setPhase('confirm')}
            className="h-12 rounded-2xl bg-white/10 px-8 text-[15px] font-semibold text-fg"
          >
            结束测试
          </button>
        </div>
      )}

      {phase === 'confirm' && (
        <div className="m-auto flex w-full max-w-sm flex-col items-center gap-6 text-center">
          <div className="flex flex-col items-center gap-1">
            <span className="text-sm text-muted">测得延迟</span>
            <span className="num text-5xl font-black">
              {latency} <span className="text-xl font-semibold text-muted">ms</span>
            </span>
          </div>
          <p className="m-0 text-[15px] leading-6 text-fg-2">设为当前的耳返延迟吗？耳返会提前 {latency} ms 播放。</p>
          <div className="flex w-full flex-col gap-3">
            <button
              type="button"
              onClick={() => {
                onApply(latency)
                onClose()
              }}
              className="h-14 rounded-2xl bg-accent text-[17px] font-bold text-accent-ink"
            >
              设为当前延迟
            </button>
            <div className="flex gap-3">
              <button type="button" onClick={() => setPhase('running')} className="h-12 flex-1 rounded-2xl bg-white/8 text-[15px] text-fg-2">
                继续测试
              </button>
              <button type="button" onClick={onClose} className="h-12 flex-1 rounded-2xl bg-white/8 text-[15px] text-fg-2">
                不用了
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
