import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import clsx from 'clsx'
import type { LyricLine, PlaybackSync } from '@shared/types'
import { api, mediaUrl } from '../lib/api'
import { clockReady, clockRtt, toServerTime } from '../lib/clock'
import { artistsText } from '../lib/format'
import { currentLineIndex, hasLyrics, interludeCountdown, lineWords, wordFills } from '../lib/lyrics'
import { EarPlayer } from '../player/earPlayer'
import { connect, livePosition, useApp } from '../store/app'
import { Icon, type IconName } from '../components/icons'
import { Range, Spinner } from '../components/ui'

/**
 * 移动耳返: a full-screen phone page that plays the lead vocal / original / accompaniment in sync
 * with the TV (for in-ear monitoring), with an adjustable delay, and doubles as a teleprompter.
 *
 * Timing: the TV stamps each position report with the server-clock time its speakers play that
 * sample; this page knows the server clock too (lib/clock.ts), so "what the TV plays at time t" is
 * a straight line. The phone schedules its audio on that line (minus the user's delay), measures
 * where its own output really is, and pulls drift in with ±0.4 % rate nudges; only jumps (seek,
 * pause, a lost report) restart the audio.
 */

type Mode = 'vocals' | 'original' | 'instrumental' | 'off'

const MODES: { id: Mode; label: string; icon: IconName; note: string }[] = [
  { id: 'vocals', label: '人声', icon: 'mic', note: '只有主唱' },
  { id: 'original', label: '原唱', icon: 'headphones', note: '完整原曲' },
  { id: 'instrumental', label: '伴奏', icon: 'wave', note: '去掉主唱' },
  { id: 'off', label: '仅提词', icon: 'lyrics', note: '不出声' },
]

interface Prefs {
  mode: Mode
  volume: number
  /** + = the phone plays later than the TV, − = earlier (ms). */
  delayMs: number
  font: number
  collapsed: boolean
}

const PREFS_KEY = 'ktv.ear'
const DEFAULT_PREFS: Prefs = { mode: 'vocals', volume: 0.9, delayMs: 0, font: 1, collapsed: false }
const DELAY_LIMIT = 600

function readPrefs(): Prefs {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') as Partial<Prefs>
    return { ...DEFAULT_PREFS, ...p }
  } catch {
    return DEFAULT_PREFS
  }
}

function usePrefs(): [Prefs, (patch: Partial<Prefs>) => void] {
  const [prefs, setPrefs] = useState(readPrefs)
  const update = useCallback((patch: Partial<Prefs>) => {
    setPrefs((p) => {
      const next = { ...p, ...patch }
      try {
        localStorage.setItem(PREFS_KEY, JSON.stringify(next))
      } catch {
        /* storage unavailable */
      }
      return next
    })
  }, [])
  return [prefs, update]
}

/**
 * Smooth the TV's reports: each one predicts a line pos(t). Reports of the same uninterrupted
 * playback agree within a few ms; average them in so clock-estimate jitter doesn't shake the audio.
 * A real jump (seek, pause, new song) replaces the line.
 */
function smoothSync(prev: PlaybackSync | null, next: PlaybackSync): PlaybackSync {
  if (!prev || prev.uid !== next.uid || prev.epoch !== next.epoch || !prev.playing || !next.playing) return next
  const predicted = prev.position + (next.at - prev.at) / 1000
  const err = next.position - predicted
  if (Math.abs(err) > 0.05) return next
  return { ...next, position: predicted + err * 0.3 }
}

/** TV timeline position (s) heard at local time `perf`; null when unknown. */
function tvPosition(sync: PlaybackSync | null, perf: number): number | null {
  if (!sync) return null
  if (!sync.playing) return sync.position
  const server = toServerTime(perf)
  if (server === null) return null
  return sync.position + (server - sync.at) / 1000
}

type Status =
  | { kind: 'connecting' }
  | { kind: 'idle' }
  | { kind: 'preparing' }
  | { kind: 'paused' }
  | { kind: 'loading' }
  | { kind: 'calibrating' }
  | { kind: 'synced'; driftMs: number }
  | { kind: 'prompter' }
  | { kind: 'error'; text: string }

export default function Ear() {
  const [started, setStarted] = useState(false)
  const playerRef = useRef<EarPlayer | null>(null)
  if (!playerRef.current) playerRef.current = new EarPlayer()
  const ear = playerRef.current
  if (import.meta.env.DEV) (window as unknown as { __ktvEar: EarPlayer }).__ktvEar = ear
  const [prefs, setPrefs] = usePrefs()
  const connected = useApp((s) => s.connected)
  const player = useApp((s) => s.state.player)
  const tracks = useApp((s) => s.state.tracks)
  const rawSync = useApp((s) => s.sync)
  const cur = player.current
  const track = cur ? tracks[cur.song.id] : undefined
  const ready = track?.status === 'ready'
  const hasStems = !!track?.hasStems

  useEffect(() => connect('ear'), [])
  useEffect(() => {
    document.title = '移动耳返 · Netease KTV'
    return () => ear.stop(0.05)
  }, [ear])

  // smoothed TV timeline, kept in a ref for the timing loops
  const syncRef = useRef<PlaybackSync | null>(null)
  useEffect(() => {
    if (!rawSync) return
    syncRef.current = smoothSync(syncRef.current, rawSync)
  }, [rawSync])
  const sync = rawSync && cur && rawSync.uid === cur.uid ? rawSync : null
  if (import.meta.env.DEV) {
    // Sync diagnostics: where the phone is vs. where the TV report line says it should be.
    ;(window as unknown as { __ktvEarDebug: () => unknown }).__ktvEarDebug = () => {
      const s = syncRef.current
      const h = ear.heard()
      if (!s || !h) return { sync: !!s, heard: !!h }
      const tv = tvPosition(s, h.perf)
      return {
        syncPos: s.position,
        syncAgeMs: Math.round((toServerTime(performance.now()) ?? 0) - s.at),
        ear: h.pos,
        tv,
        driftMs: tv === null ? null : Math.round((h.pos - tv + delayRef.current / 1000) * 1000),
        rate: ear.currentRate,
        rtt: clockRtt(),
      }
    }
  }

  // what to play
  const wantMode: Mode = prefs.mode === 'vocals' && !hasStems ? 'original' : prefs.mode
  const fellBack = prefs.mode === 'vocals' && !hasStems && ready
  const url =
    started && cur && ready && wantMode !== 'off'
      ? wantMode === 'original'
        ? mediaUrl(cur.song.id, 'original', player.key)
        : mediaUrl(cur.song.id, wantMode, player.key)
      : ''

  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState('')
  useEffect(() => {
    if (!url) {
      ear.setBuffer(null, '')
      setLoading(false)
      return
    }
    if (ear.bufferUrl === url) return
    let cancelled = false
    setLoading(true)
    setLoadError('')
    ear
      .load(url)
      .then((buf) => {
        if (cancelled) return
        ear.setBuffer(buf, url)
        setLoading(false)
        kick.current()
      })
      .catch((e: unknown) => {
        if (cancelled) return
        setLoading(false)
        setLoadError(e instanceof Error ? e.message : '音频加载失败')
      })
    return () => {
      cancelled = true
    }
  }, [url, ear])

  useEffect(() => ear.setVolume(prefs.volume), [ear, prefs.volume, started])

  // ---- the sync loop ----
  const delayRef = useRef(prefs.delayMs)
  const [drift, setDrift] = useState<number | null>(null)
  const driftEma = useRef<number | null>(null)
  const lastStart = useRef(0)
  const forceRestart = useRef(false)
  const curUid = cur?.uid
  const tick = useCallback(() => {
    const s = syncRef.current
    const target = (perf: number) => {
      const p = tvPosition(s, perf)
      return p === null ? NaN : p - delayRef.current / 1000
    }
    const playable = !!ear.buffer && !!s && s.uid === curUid && s.playing && clockReady()
    if (!playable) {
      if (ear.playing) ear.stop(0.12)
      driftEma.current = null
      setDrift(null)
      return
    }
    const now = performance.now()
    if (!ear.playing || forceRestart.current) {
      forceRestart.current = false
      if (Number.isNaN(target(now))) return
      ear.start(target)
      lastStart.current = now
      driftEma.current = null
      return
    }
    const h = ear.heard()
    if (!h) return
    const want = target(h.perf)
    if (Number.isNaN(want)) return
    const d = h.pos - want // + = the phone is ahead
    driftEma.current = driftEma.current === null ? d : driftEma.current * 0.7 + d * 0.3
    setDrift(driftEma.current)
    // Big jump (seek, pause/resume, a late report): restart on the line. Otherwise nudge the rate:
    // 0.4 % at most, which moves 4 ms per second and is far below what an ear can hear as pitch.
    if (Math.abs(d) > 0.08 && now - lastStart.current > 800) {
      ear.start(target)
      lastStart.current = now
      driftEma.current = null
      return
    }
    const e = driftEma.current
    const rate = Math.abs(e) < 0.003 ? 1 : 1 - Math.max(-0.004, Math.min(0.004, e / 2.5))
    ear.setRate(rate)
  }, [ear, curUid])
  const kick = useRef(tick)
  kick.current = tick

  useEffect(() => {
    if (!started) return
    const t = window.setInterval(() => kick.current(), 200)
    return () => window.clearInterval(t)
  }, [started])
  // react right away to play / pause / seek reports
  useEffect(() => {
    if (started) kick.current()
  }, [rawSync?.playing, rawSync?.uid, rawSync?.epoch, started])
  // a delay change restarts on the new line (a slider drag shouldn't take seconds to settle)
  useEffect(() => {
    delayRef.current = prefs.delayMs
    if (!started) return
    const t = window.setTimeout(() => {
      forceRestart.current = true
      kick.current()
    }, 150)
    return () => window.clearTimeout(t)
  }, [prefs.delayMs, started])

  // keep the screen on (it is a teleprompter) and re-acquire after the tab comes back
  useEffect(() => {
    if (!started || !('wakeLock' in navigator)) return
    let lock: WakeLockSentinel | null = null
    const acquire = () => {
      if (document.visibilityState !== 'visible') return
      navigator.wakeLock
        .request('screen')
        .then((l) => (lock = l))
        .catch(() => {})
    }
    acquire()
    document.addEventListener('visibilitychange', acquire)
    return () => {
      document.removeEventListener('visibilitychange', acquire)
      void lock?.release().catch(() => {})
    }
  }, [started])

  async function start() {
    try {
      await ear.unlock()
      setStarted(true)
      document.documentElement.requestFullscreen?.().catch(() => {})
    } catch {
      setStarted(false)
    }
  }

  // ---- status ----
  const status: Status = !connected
    ? { kind: 'connecting' }
    : !cur
      ? { kind: 'idle' }
      : !ready
        ? { kind: 'preparing' }
        : loadError
          ? { kind: 'error', text: loadError }
          : !sync || !sync.playing
            ? { kind: 'paused' }
            : wantMode === 'off'
              ? { kind: 'prompter' }
              : loading
                ? { kind: 'loading' }
                : !clockReady()
                  ? { kind: 'calibrating' }
                  : drift === null
                    ? { kind: 'calibrating' }
                    : { kind: 'synced', driftMs: Math.abs(drift * 1000) }

  if (!started) return <StartScreen onStart={start} />

  return (
    <div className="fixed inset-0 flex flex-col overflow-hidden bg-ink text-fg select-none">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-40 -left-32 h-[420px] w-[420px] rounded-full opacity-25 blur-[30px]"
        style={{ background: 'radial-gradient(circle, #FF4D7E 0%, rgba(0,0,0,0) 65%)' }}
      />
      <header className="relative flex items-center gap-2 px-3 pt-[max(10px,env(safe-area-inset-top))] pb-2">
        <Link
          to="/m"
          aria-label="返回遥控"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-fg-2 hover:bg-white/8"
        >
          <Icon name="chevronLeft" size={22} />
        </Link>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[15px] font-semibold">{cur ? cur.song.name : '移动耳返'}</span>
          <span className="truncate text-xs text-muted">{cur ? artistsText(cur.song) : '等待点歌'}</span>
        </div>
        <StatusPill status={status} />
      </header>

      <Prompter songId={cur?.song.id ?? null} uid={cur?.uid ?? null} syncRef={syncRef} font={prefs.font} />

      {fellBack && prefs.mode === 'vocals' && (
        <p className="relative m-0 px-5 pb-2 text-center text-xs text-warn">这首歌没有分离出人声，正在播放原唱</p>
      )}

      <Controls prefs={prefs} setPrefs={setPrefs} rate={ear.currentRate} />
    </div>
  )
}

// ---------------- start ----------------

function StartScreen({ onStart }: { onStart: () => void }) {
  return (
    <div className="fixed inset-0 flex flex-col overflow-y-auto bg-ink px-6 pt-[max(16px,env(safe-area-inset-top))] pb-[max(24px,env(safe-area-inset-bottom))] text-fg">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-40 left-1/2 h-[520px] w-[520px] -translate-x-1/2 rounded-full opacity-30 blur-[30px]"
        style={{ background: 'radial-gradient(circle, #8B5CF6 0%, rgba(0,0,0,0) 65%)' }}
      />
      <Link to="/m" className="relative flex h-10 w-10 items-center justify-center rounded-xl text-fg-2 hover:bg-white/8" aria-label="返回遥控">
        <Icon name="chevronLeft" size={22} />
      </Link>
      <div className="relative m-auto flex w-full max-w-sm flex-col items-center gap-7 py-8 text-center">
        <div className="flex h-20 w-20 items-center justify-center rounded-[24px] bg-[linear-gradient(135deg,#FF4D7E_0%,#8B5CF6_100%)] text-white shadow-[0_20px_60px_rgba(139,92,246,0.45)]">
          <Icon name="headphones" size={38} strokeWidth={2} />
        </div>
        <div className="flex flex-col gap-2">
          <h1 className="m-0 text-[30px] font-black tracking-[0.02em]">移动耳返</h1>
          <p className="m-0 text-[15px] leading-6 text-muted">戴上耳机，跟着主屏一起唱</p>
        </div>
        <ul className="m-0 flex w-full list-none flex-col gap-3 p-0 text-left text-sm leading-6 text-fg-2">
          <Feature icon="mic" text="单独听主唱人声、原唱或伴奏，和主屏同步播放" />
          <Feature icon="clock" text="耳机里早了或晚了，可以前后微调几百毫秒" />
          <Feature icon="lyrics" text="同时是一个小提词器，屏幕保持常亮" />
        </ul>
        <button
          type="button"
          onClick={onStart}
          className="flex h-14 w-full items-center justify-center gap-2 rounded-2xl bg-accent text-[17px] font-bold text-accent-ink shadow-[0_14px_36px_rgba(255,77,126,0.4)]"
        >
          <Icon name="play" size={20} />
          开始
        </button>
        <p className="m-0 text-xs leading-5 text-faint">蓝牙耳机延迟较大，如果听起来比主屏晚，把延迟往“提前”调。</p>
      </div>
    </div>
  )
}

function Feature({ icon, text }: { icon: IconName; text: string }) {
  return (
    <li className="flex items-start gap-3 rounded-2xl border border-white/7 bg-white/[0.03] px-4 py-3">
      <Icon name={icon} size={18} className="mt-[3px] shrink-0 text-accent-soft" />
      {text}
    </li>
  )
}

// ---------------- status ----------------

function StatusPill({ status }: { status: Status }) {
  let text = ''
  let tone: 'ok' | 'warn' | 'idle' | 'bad' = 'idle'
  let spin = false
  switch (status.kind) {
    case 'connecting':
      text = '连接中'
      spin = true
      break
    case 'idle':
      text = '等待点歌'
      break
    case 'preparing':
      text = '主屏准备中'
      spin = true
      break
    case 'paused':
      text = '已暂停'
      break
    case 'loading':
      text = '加载音频'
      spin = true
      break
    case 'calibrating':
      text = '同步中'
      spin = true
      break
    case 'prompter':
      text = '提词'
      tone = 'ok'
      break
    case 'error':
      text = '加载失败'
      tone = 'bad'
      break
    case 'synced':
      tone = status.driftMs < 15 ? 'ok' : 'warn'
      text = status.driftMs < 3 ? '已同步' : `已同步 ±${Math.round(status.driftMs)}ms`
      break
  }
  const dot = { ok: 'bg-ok-dot', warn: 'bg-warn-dot', idle: 'bg-faint', bad: 'bg-accent' }[tone]
  return (
    <span
      role="status"
      title={status.kind === 'synced' ? `时钟往返 ${Math.round(clockRtt())}ms` : undefined}
      className="flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-3 text-xs whitespace-nowrap text-fg-2"
    >
      {spin ? <Spinner size={12} /> : <span className={clsx('h-1.5 w-1.5 rounded-full', dot)} />}
      <span className="num">{text}</span>
    </span>
  )
}

// ---------------- prompter ----------------

function Prompter({
  songId,
  uid,
  syncRef,
  font,
}: {
  songId: number | null
  uid: string | null
  syncRef: React.RefObject<PlaybackSync | null>
  font: number
}) {
  const { data } = useQuery({
    queryKey: ['lyrics', songId],
    queryFn: () => api.lyrics(songId!),
    enabled: songId !== null,
    staleTime: Infinity,
  })
  const lines = useMemo(() => (data && hasLyrics(data) ? data.lines : []), [data])
  const [idx, setIdx] = useState(-1)
  const [dots, setDots] = useState<{ index: number; dots: number; total: number } | null>(null)
  const wordRefs = useRef<(HTMLSpanElement | null)[]>([])
  const player = useApp((s) => s.state.player)
  const playerRef = useRef(player)
  playerRef.current = player

  useEffect(() => {
    if (!lines.length) return
    let raf = 0
    let lastIdx = -2
    let lastDots = ''
    const frame = () => {
      raf = requestAnimationFrame(frame)
      const s = syncRef.current
      const p = playerRef.current
      let pos = s && s.uid === uid ? tvPosition(s, performance.now()) : null
      if (pos === null) pos = p.current?.uid === uid ? livePosition(p) : 0
      const ms = pos * 1000
      const i = currentLineIndex(lines, ms)
      if (i !== lastIdx) {
        lastIdx = i
        setIdx(i)
      }
      const cd = interludeCountdown(lines, ms)
      const key = cd ? `${cd.index}:${cd.dots}` : ''
      if (key !== lastDots) {
        lastDots = key
        setDots(cd)
      }
      const line = lines[i]
      if (line) {
        const fills = wordFills(line, ms)
        fills.forEach((f, k) => wordRefs.current[k]?.style.setProperty('--p', `${f}%`))
      }
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [lines, uid, syncRef])

  if (!songId) {
    return (
      <div className="relative flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
        <Icon name="note" size={30} className="text-faint" />
        <p className="m-0 text-[15px] text-muted">点一首歌，歌词会显示在这里</p>
      </div>
    )
  }
  if (!lines.length) {
    return (
      <div className="relative flex flex-1 items-center justify-center px-6 text-center">
        <p className="m-0 text-[15px] text-muted">{data ? '这首歌没有歌词' : '加载歌词…'}</p>
      </div>
    )
  }

  const cur = idx >= 0 ? lines[idx] : null
  const prev = idx > 0 ? lines[idx - 1] : null
  // Before the first line, show it as "next".
  const next = lines[idx + 1] ?? null
  const after = lines[idx + 2] ?? null
  const scale = (px: number) => `${Math.round(px * font)}px`

  return (
    <div className="relative flex min-h-0 flex-1 flex-col items-center justify-center gap-[2.2vh] overflow-hidden px-5 text-center">
      {prev && <PlainLine line={prev} className="text-faint" size={scale(17)} />}
      {cur ? (
        <div className="flex flex-col items-center gap-2">
          <p
            key={idx}
            className="m-0 leading-[1.3] font-black tracking-[0.01em] break-words"
            style={{ fontSize: scale(32) }}
          >
            {lineWords(cur).map((w, k) => (
              <span
                key={k}
                ref={(el) => {
                  wordRefs.current[k] = el
                }}
                className="ear-word"
              >
                {w.text}
              </span>
            ))}
          </p>
          {cur.translation && (
            <p className="m-0 text-muted" style={{ fontSize: scale(15) }}>
              {cur.translation}
            </p>
          )}
        </div>
      ) : (
        <p className="m-0 text-muted" style={{ fontSize: scale(17) }}>
          前奏
        </p>
      )}
      {next && (
        <div className="flex flex-col items-center gap-2">
          {dots && dots.index === idx + 1 && <Dots n={dots.dots} total={dots.total} />}
          <PlainLine line={next} className="font-semibold text-fg-2" size={scale(22)} />
        </div>
      )}
      {after && <PlainLine line={after} className="text-subtle" size={scale(17)} />}
    </div>
  )
}

function PlainLine({ line, className, size }: { line: LyricLine; className?: string; size: string }) {
  return (
    <p className={clsx('m-0 leading-[1.35] break-words', className)} style={{ fontSize: size }}>
      {line.text}
    </p>
  )
}

function Dots({ n, total }: { n: number; total: number }) {
  return (
    <span aria-label={`${n} 秒后开始`} className="flex gap-2">
      {Array.from({ length: total }, (_, i) => (
        <span
          key={i}
          className={clsx('h-2.5 w-2.5 rounded-full transition-opacity duration-300', i < n ? 'bg-accent opacity-100' : 'opacity-0')}
        />
      ))}
    </span>
  )
}

// ---------------- controls ----------------

function Controls({ prefs, setPrefs, rate }: { prefs: Prefs; setPrefs: (p: Partial<Prefs>) => void; rate: number }) {
  void rate
  const delay = prefs.delayMs
  const setDelay = (v: number) => setPrefs({ delayMs: Math.max(-DELAY_LIMIT, Math.min(DELAY_LIMIT, Math.round(v))) })
  const delayText = delay === 0 ? '与主屏同步' : delay > 0 ? `延后 ${delay} ms` : `提前 ${-delay} ms`

  // ---- drag the handle to open / close the lower part of the sheet ----
  const bodyRef = useRef<HTMLDivElement>(null)
  const [fullH, setFullH] = useState(0)
  useLayoutEffect(() => {
    const el = bodyRef.current
    if (!el) return
    const measure = () => setFullH(el.offsetHeight)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const [dragH, setDragH] = useState<number | null>(null)
  const drag = useRef<{ y0: number; h0: number; h: number; lastY: number; lastT: number; v: number; moved: boolean } | null>(null)
  const toggle = () => setPrefs({ collapsed: !prefs.collapsed })
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    try {
      e.currentTarget.setPointerCapture(e.pointerId) // keep getting moves when the finger leaves the handle
    } catch {
      /* pointer already gone */
    }
    const h0 = prefs.collapsed ? 0 : fullH
    drag.current = { y0: e.clientY, h0, h: h0, lastY: e.clientY, lastT: e.timeStamp, v: 0, moved: false }
  }
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d) return
    const dy = e.clientY - d.y0
    if (!d.moved && Math.abs(dy) < 5) return
    d.moved = true
    const dt = e.timeStamp - d.lastT
    if (dt > 0) d.v = d.v * 0.6 + ((e.clientY - d.lastY) / dt) * 0.4 // px/ms, + = downwards
    d.lastY = e.clientY
    d.lastT = e.timeStamp
    // Follows the finger; a little rubber band past either end.
    const raw = d.h0 - dy
    d.h = raw < 0 ? raw / 4 : raw > fullH ? fullH + (raw - fullH) / 4 : raw
    setDragH(Math.max(0, d.h))
  }
  const onPointerUp = () => {
    const d = drag.current
    drag.current = null
    if (!d) return
    if (!d.moved) {
      toggle()
      return
    }
    // A flick decides; otherwise snap to whichever end is closer.
    const collapse = d.v > 0.35 ? true : d.v < -0.35 ? false : d.h < fullH / 2
    setDragH(null)
    setPrefs({ collapsed: collapse })
  }
  const open = dragH !== null ? dragH > 0 : !prefs.collapsed
  const height = dragH !== null ? dragH : prefs.collapsed ? 0 : fullH || 'auto'

  return (
    <section
      aria-label="耳返设置"
      className="relative rounded-t-[28px] border-t border-white/8 bg-[#121219] px-4 pb-[max(14px,env(safe-area-inset-bottom))]"
    >
      <div
        role="button"
        tabIndex={0}
        aria-expanded={!prefs.collapsed}
        aria-label={prefs.collapsed ? '展开设置（可上下拖动）' : '收起设置（可上下拖动）'}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            toggle()
          }
        }}
        className="-mx-4 flex h-9 cursor-grab touch-none items-center justify-center select-none active:cursor-grabbing"
      >
        <span className={clsx('h-1.5 w-11 rounded-full transition-colors', dragH !== null ? 'bg-white/45' : 'bg-white/22')} />
      </div>

      <div role="radiogroup" aria-label="耳返内容" className="grid grid-cols-4 gap-1.5">
        {MODES.map((m) => {
          const on = prefs.mode === m.id
          return (
            <button
              key={m.id}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => setPrefs({ mode: m.id })}
              className={clsx(
                'flex h-14 flex-col items-center justify-center gap-0.5 rounded-2xl text-[13px] transition-colors',
                on ? 'bg-fg font-semibold text-ink' : 'bg-white/5 text-fg-2',
              )}
            >
              <Icon name={m.icon} size={18} />
              {m.label}
            </button>
          )
        })}
      </div>

      <div
        style={{ height }}
        className={clsx('overflow-hidden', dragH === null && 'transition-[height] duration-300 ease-[cubic-bezier(0.2,0.8,0.2,1)]')}
        aria-hidden={!open}
        inert={!open}
      >
        <div ref={bodyRef} className="flex flex-col gap-4 pt-4">
          <div className={clsx('flex items-center gap-3', prefs.mode === 'off' && 'pointer-events-none opacity-40')}>
            <Icon name="volume" size={18} className="shrink-0 text-muted" />
            <div className="flex-1">
              <Range label="耳返音量" value={Math.round(prefs.volume * 100)} onChange={(v) => setPrefs({ volume: v / 100 })} />
            </div>
            <span className="num w-10 text-right text-sm text-fg-2">{Math.round(prefs.volume * 100)}</span>
          </div>

          <div className={clsx('flex flex-col gap-2', prefs.mode === 'off' && 'pointer-events-none opacity-40')}>
            <div className="flex items-center justify-between">
              <span className="text-sm text-fg-2">延迟</span>
              <span className={clsx('num text-sm font-semibold', delay === 0 ? 'text-muted' : 'text-accent')}>{delayText}</span>
            </div>
            <div className="flex items-center gap-2">
              <StepButton label="提前 10 毫秒" onClick={() => setDelay(delay - 10)} icon="minus" />
              <div className="flex-1">
                <Range
                  label="耳返延迟（毫秒）"
                  min={-DELAY_LIMIT}
                  max={DELAY_LIMIT}
                  value={delay}
                  onChange={(v) => setDelay(Math.round(v / 5) * 5)}
                />
              </div>
              <StepButton label="延后 10 毫秒" onClick={() => setDelay(delay + 10)} icon="plus" />
            </div>
            <div className="flex items-center justify-between text-[11px] text-faint">
              <span>← 提前</span>
              {delay !== 0 && (
                <button type="button" onClick={() => setDelay(0)} className="rounded-md px-2 py-0.5 text-xs text-accent-soft">
                  归零
                </button>
              )}
              <span>延后 →</span>
            </div>
          </div>

          <div className="flex items-center justify-between">
            <span className="text-sm text-fg-2">字号</span>
            <div className="flex items-center gap-1.5">
              <StepButton label="缩小字号" onClick={() => setPrefs({ font: Math.max(0.7, +(prefs.font - 0.1).toFixed(1)) })} text="A−" />
              <span className="num w-12 text-center text-sm text-muted">{Math.round(prefs.font * 100)}%</span>
              <StepButton label="放大字号" onClick={() => setPrefs({ font: Math.min(1.8, +(prefs.font + 0.1).toFixed(1)) })} text="A+" />
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

function StepButton({ label, onClick, icon, text }: { label: string; onClick: () => void; icon?: IconName; text?: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white/6 text-sm font-semibold text-fg-2 active:bg-white/12"
    >
      {icon ? <Icon name={icon} size={16} /> : text}
    </button>
  )
}
