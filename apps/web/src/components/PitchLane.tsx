import { useEffect, useRef, type MutableRefObject } from 'react'
import type { LaneData } from '../player/useScoring'

const WINDOW = 5 // seconds visible
const NOW_AT = 0.25 // "now" line position (fraction of width)
const ACCENT = '#FF4D7E'

function fitRange(lane: LaneData): [number, number] {
  let lo = Infinity
  let hi = -Infinity
  for (const n of lane.notes) {
    lo = Math.min(lo, n.midi)
    hi = Math.max(hi, n.midi)
  }
  if (!Number.isFinite(lo)) return [48 + lane.key, 72 + lane.key]
  lo += lane.key - 2
  hi += lane.key + 2
  if (hi - lo < 12) {
    const mid = (lo + hi) / 2
    lo = mid - 6
    hi = mid + 6
  }
  return [lo, hi]
}

/**
 * Scrolling reference-melody lane: note bars move right→left past a fixed "now"
 * line, the singer's pitch is drawn as a glowing trace, hit notes light up.
 */
export function PitchLane({
  lane,
  getTime,
  score,
}: {
  lane: MutableRefObject<LaneData>
  getTime: () => number
  score: number
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    let raf = 0
    let range: [number, number] = [48, 72]
    let rangeFor: unknown = null
    let rangeKey = NaN

    const resize = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      const r = canvas.getBoundingClientRect()
      canvas.width = Math.max(1, Math.round(r.width * dpr))
      canvas.height = Math.max(1, Math.round(r.height * dpr))
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(canvas)

    const draw = () => {
      const data = lane.current
      const W = canvas.width
      const H = canvas.height
      const dpr = W / Math.max(1, canvas.clientWidth)
      if (rangeFor !== data.notes || rangeKey !== data.key) {
        range = fitRange(data)
        rangeFor = data.notes
        rangeKey = data.key
      }
      const [lo, hi] = range
      const now = getTime()
      const t0 = now - WINDOW * NOW_AT
      const X = (t: number) => ((t - t0) / WINDOW) * W
      const pad = 10 * dpr
      const Y = (m: number) => pad + (1 - (m - lo) / (hi - lo)) * (H - 2 * pad)
      const barH = Math.max(5 * dpr, ((H - 2 * pad) / (hi - lo)) * 0.85)
      const nowX = W * NOW_AT

      ctx.clearRect(0, 0, W, H)

      // faint guide lines every octave (C notes)
      ctx.strokeStyle = 'rgba(255,255,255,0.05)'
      ctx.lineWidth = dpr
      for (let m = Math.ceil(lo / 12) * 12; m <= hi; m += 12) {
        const y = Math.round(Y(m)) + 0.5
        ctx.beginPath()
        ctx.moveTo(0, y)
        ctx.lineTo(W, y)
        ctx.stroke()
      }

      // reference notes
      data.notes.forEach((n, i) => {
        if (n.t1 < t0 || n.t0 > t0 + WINDOW) return
        const x0 = X(n.t0)
        const x1 = X(n.t1)
        const y = Y(n.midi + data.key) - barH / 2
        const hit = data.keeper.hits.has(i)
        const past = n.t1 <= now
        const live = n.t0 <= now && now < n.t1
        ctx.shadowBlur = 0
        if (hit) {
          ctx.fillStyle = ACCENT
          ctx.shadowColor = ACCENT
          ctx.shadowBlur = (live ? 18 : 8) * dpr
        } else ctx.fillStyle = past ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.26)'
        ctx.beginPath()
        if (ctx.roundRect) ctx.roundRect(x0, y, Math.max(2 * dpr, x1 - x0 - 2 * dpr), barH, barH / 2)
        else ctx.rect(x0, y, Math.max(2 * dpr, x1 - x0 - 2 * dpr), barH)
        ctx.fill()
      })
      ctx.shadowBlur = 0

      // singer trace
      const fold = (m: number) => {
        let v = m
        while (v < lo) v += 12
        while (v > hi) v -= 12
        return v
      }
      ctx.lineWidth = 3 * dpr
      ctx.lineJoin = 'round'
      ctx.lineCap = 'round'
      ctx.strokeStyle = '#FFD1DE'
      ctx.shadowColor = ACCENT
      ctx.shadowBlur = 12 * dpr
      ctx.beginPath()
      let pen = false
      let lastY = 0
      for (const p of data.trace) {
        if (p.m === null || p.t > now + 0.05) {
          pen = false
          continue
        }
        const x = X(p.t)
        const y = Y(fold(p.m))
        if (pen && Math.abs(y - lastY) < (H - 2 * pad) / 3) ctx.lineTo(x, y)
        else ctx.moveTo(x, y)
        pen = true
        lastY = y
      }
      ctx.stroke()
      ctx.shadowBlur = 0

      // now line
      const g = ctx.createLinearGradient(0, 0, 0, H)
      g.addColorStop(0, 'rgba(255,77,126,0)')
      g.addColorStop(0.5, 'rgba(255,77,126,0.9)')
      g.addColorStop(1, 'rgba(255,77,126,0)')
      ctx.fillStyle = g
      ctx.fillRect(nowX - dpr, 0, 2 * dpr, H)

      // singer dot
      const lastPt = data.trace[data.trace.length - 1]
      if (lastPt && lastPt.m !== null && now - lastPt.t < 0.15) {
        ctx.fillStyle = '#FFFFFF'
        ctx.shadowColor = ACCENT
        ctx.shadowBlur = 16 * dpr
        ctx.beginPath()
        ctx.arc(nowX, Y(fold(lastPt.m)), 5 * dpr, 0, Math.PI * 2)
        ctx.fill()
        ctx.shadowBlur = 0
      }

      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
    }
  }, [lane, getTime])

  return (
    <div className="glass relative h-[120px] w-full overflow-hidden rounded-[22px]">
      <canvas ref={canvasRef} aria-hidden="true" className="absolute inset-0 h-full w-full" />
      <div className="absolute top-2.5 left-4 flex items-center gap-2 text-xs tracking-[0.12em] text-muted">
        <span className="h-1.5 w-1.5 rounded-full bg-accent shadow-[0_0_8px_#FF4D7E]" aria-hidden="true" />
        KTV 打分
      </div>
      <div className="absolute top-2 right-4 flex items-baseline gap-1" aria-live="off">
        <span className="num text-[34px] leading-none font-bold tabular-nums">{Math.round(score)}</span>
        <span className="text-xs text-muted">分</span>
      </div>
    </div>
  )
}
