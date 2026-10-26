import { useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import clsx from 'clsx'
import type { PlayerState, Song, TrackState } from '@shared/types'
import { artistsText, deriveStatus, keyText } from '../../lib/format'
import { useApp } from '../../store/app'
import { Icon, type IconName } from '../../components/icons'
import { Cover, ProgressBar, Spinner, StatusPill } from '../../components/ui'
import { QrCard, ScreenRoleControl, singerOf } from './chrome'
import { reduceMotion } from './lyrics'
import { MicCorner } from './micControl'
import type { MicControl } from '../../player/useMicMixer'

/** 大屏 full-screen states and overlays: idle, preparing, 即将开始, OSD, 接下来 panel, UI auto-hide. */

/**
 * True after `timeout` ms without pointer / key / touch activity. Never goes idle while
 * the pointer is over the held area or one of its controls has keyboard focus.
 */
export function useIdle(enabled: boolean, timeout = 4000) {
  const [idle, setIdle] = useState(false)
  const holdRef = useRef<HTMLDivElement | null>(null)
  const hoverRef = useRef(false)
  useEffect(() => {
    if (!enabled) {
      setIdle(false)
      return
    }
    let t = 0
    const check = () => {
      const el = holdRef.current
      const active = document.activeElement as HTMLElement | null
      const focused = !!el && !!active && el.contains(active) && active.matches(':focus-visible')
      if (hoverRef.current || focused) arm()
      else setIdle(true)
    }
    const arm = () => {
      window.clearTimeout(t)
      t = window.setTimeout(check, timeout)
    }
    const wake = () => {
      setIdle(false)
      arm()
    }
    const events = ['pointermove', 'pointerdown', 'keydown', 'touchstart', 'wheel'] as const
    events.forEach((e) => window.addEventListener(e, wake, { passive: true }))
    arm()
    return () => {
      window.clearTimeout(t)
      events.forEach((e) => window.removeEventListener(e, wake))
    }
  }, [enabled, timeout])
  return { idle, holdRef, hoverRef }
}

export interface OsdMsg {
  id: number
  text: string
  icon?: IconName
}

export function Osd({ msg }: { msg: OsdMsg | null }) {
  return (
    <div className="pointer-events-none absolute top-[9vh] left-1/2 z-30 -translate-x-1/2" aria-live="polite">
      <AnimatePresence>
        {msg && (
          <motion.div
            key={msg.id}
            initial={{ opacity: 0, y: -10, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: reduceMotion() ? 0 : 0.2 }}
            className="glass flex items-center gap-2.5 rounded-full px-6 py-3 text-[clamp(18px,1.3vw,26px)] font-semibold whitespace-nowrap shadow-[0_16px_40px_rgba(0,0,0,0.45)]"
          >
            {msg.icon && <Icon name={msg.icon} size={22} className="text-accent" />}
            {msg.text}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

export const pctText = (v: number) => Math.round(v * 100) + '%'

/** Turn player-state changes (usually from the phone) into short on-screen messages. */
export function useOsd(player: PlayerState, announceDisplayMode: boolean, quietSongChange: boolean) {
  const [msg, setMsg] = useState<OsdMsg | null>(null)
  // The score card already says the song is over.
  const quiet = useRef(quietSongChange)
  quiet.current = quietSongChange
  // A silent extra screen keeps its own 舞台 / MV mode, so the synced mode isn't news there.
  const announceMode = useRef(announceDisplayMode)
  announceMode.current = announceDisplayMode
  const storeReady = useApp((s) => s.ready)
  const prevRef = useRef<PlayerState | null>(null)
  const show = useCallback((text: string, icon?: IconName) => setMsg({ id: Date.now() + Math.random(), text, icon }), [])
  useEffect(() => {
    if (!msg) return
    const t = window.setTimeout(() => setMsg(null), 1400)
    return () => window.clearTimeout(t)
  }, [msg])
  useEffect(() => {
    if (!storeReady) {
      prevRef.current = null
      return
    }
    const prev = prevRef.current
    prevRef.current = player
    if (!prev) return
    const sameSong = prev.current?.uid === player.current?.uid
    if (!sameSong) {
      if (prev.current && player.current && !quiet.current) show(`下一首 · 《${player.current.song.name}》`, 'next')
      return
    }
    // 伴唱 / 领唱 / 原唱 changes need no banner: the control bar and header chip already show it.
    if (prev.displayMode !== player.displayMode) {
      if (announceMode.current) show(player.displayMode === 'mv' ? 'MV 模式' : '舞台模式', player.displayMode === 'mv' ? 'video' : 'lyrics')
    }
    else if (prev.key !== player.key) show(keyText(player.key))
    else if (prev.musicVolume !== player.musicVolume) show(`音量 ${pctText(player.musicVolume)}`, 'volume')
    else if (prev.idleVolume !== player.idleVolume && !player.current) show(`待机音乐 ${pctText(player.idleVolume)}`, 'volume')
    else if (prev.micOn !== player.micOn) show(player.micOn ? '麦克风已打开' : '麦克风已关闭', 'mic')
    else if (prev.micVolume !== player.micVolume) show(`麦克风 ${pctText(player.micVolume)}`, 'mic')
    else if (prev.reverb !== player.reverb) show(`混响 ${pctText(player.reverb)}`, 'sparkles')
  }, [player, storeReady, show])
  return { msg, show }
}

export function IdleScreen({
  onMakeMain,
  idleSong,
  muted,
  onToggleMute,
  volume,
  onVolume,
  mic,
}: {
  onMakeMain?: () => void
  idleSong: Song | null
  /** The 主屏 microphone switch (the control bar is not shown while nothing is queued). */
  mic?: MicControl
  /** A 大屏 that isn't the 主屏 (多大屏播放 on): its mute switch and own volume, as on the control bar. */
  muted?: boolean
  onToggleMute?: () => void
  volume?: number
  onVolume?: (v: number) => void
}) {
  const connected = useApp((s) => s.connected)
  return (
    <motion.div
      className="absolute inset-0 flex flex-col items-center justify-center gap-[6vh] px-[4vw] text-center"
      initial={{ opacity: 0, scale: 0.985 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 1.2, ease: 'easeOut' }}
    >
      <div className="flex flex-col items-center gap-5">
        <div className="flex h-20 w-20 items-center justify-center rounded-[24px] bg-[linear-gradient(135deg,#FF4D7E_0%,#8B5CF6_100%)] text-white shadow-[0_20px_60px_rgba(255,77,126,0.45)]">
          <Icon name="mic" size={40} strokeWidth={2} />
        </div>
        <h1 className="m-0 text-[clamp(40px,4.4vw,88px)] font-black tracking-[0.02em]">今晚，谁先开嗓？</h1>
        <p className="m-0 text-[clamp(16px,1.4vw,26px)] text-[#B4B4BE]">
          {connected ? '手机扫码，即刻开唱' : '正在连接 KTV 主机…'}
        </p>
      </div>
      <QrCard big />
      <AnimatePresence>
        {idleSong && (
          <motion.div
            key={idleSong.id}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.6 }}
            className="glass absolute bottom-[5.2vh] left-[3.75vw] flex max-w-[40vw] items-center gap-3 rounded-full py-2 pr-5 pl-2 text-[clamp(14px,1.1vw,22px)] text-fg-2"
          >
            <Cover song={idleSong} px={80} className="h-9 w-9 rounded-full" />
            <Icon name="note" size={18} className="shrink-0 text-accent-soft" />
            <span className="truncate">
              待机音乐 · {idleSong.name} · {artistsText(idleSong)}
            </span>
          </motion.div>
        )}
      </AnimatePresence>
      {onMakeMain && (
        <div className="absolute right-[3.75vw] bottom-[5.2vh]">
          <ScreenRoleControl onMakeMain={onMakeMain} muted={muted} onToggleMute={onToggleMute} volume={volume} onVolume={onVolume} compact />
        </div>
      )}
      {!onMakeMain && mic && (
        <div className="absolute right-[3.75vw] bottom-[5.2vh]">
          <MicCorner mic={mic} />
        </div>
      )}
    </motion.div>
  )
}

export function PreparingScreen({
  song,
  track,
  loading,
  loadError,
  onMakeMain,
}: {
  song: Song
  track?: TrackState
  loading: boolean
  loadError: string
  /** Set on a 大屏 that isn't the 主屏: it shows the song once the 主屏 starts it. */
  onMakeMain?: () => void
}) {
  const waitingForMain = !!onMakeMain && track?.status === 'ready' && !loadError
  const longWait = useDelayedFlag(waitingForMain, 4000)
  let title = '正在准备'
  let detail = ''
  let progress: number | null = null
  let tone: 'normal' | 'warn' = 'normal'
  switch (track?.status) {
    case 'downloading':
      title = '正在下载歌曲'
      progress = track.progress
      break
    case 'queued':
      title = '排队等待生成伴奏'
      detail = '前面还有歌曲在处理'
      break
    case 'separating':
      title = '正在生成伴奏'
      progress = track.progress
      detail = 'AI 正在去除主唱、保留和声'
      break
    case 'unavailable':
      title = '这首歌无法播放'
      detail = track.message || (song.playable === 'vip' ? '需要会员才能播放完整版' : '网易云暂无音源')
      tone = 'warn'
      break
    case 'error':
      title = '伴奏生成失败'
      detail = (track.message ? track.message + ' · ' : '') + '可在点歌台重试或切到下一首'
      tone = 'warn'
      break
    case 'ready':
      title = loadError ? '音频加载失败' : '正在加载音频'
      detail = loadError
      tone = loadError ? 'warn' : 'normal'
      break
  }
  if (waitingForMain) {
    title = '等待主屏播放'
    detail = longWait ? '主屏还没开始？到主屏上点击「开始 KTV」，或把这块屏设为主屏' : ''
  }
  return (
    <div className="absolute inset-0 flex items-center justify-center px-[4vw]">
      <div className="flex flex-col items-center gap-8 text-center">
        <div className="relative">
          <Cover song={song} px={600} className="h-[34vh] w-[34vh] rounded-[32px] shadow-[0_30px_80px_rgba(0,0,0,0.55)]" />
          {(loading || progress !== null || track?.status === 'queued' || waitingForMain) && tone === 'normal' && (
            <div className="absolute -right-4 -bottom-4 flex h-16 w-16 items-center justify-center rounded-full bg-accent text-accent-ink shadow-[0_10px_30px_rgba(255,77,126,0.5)]">
              <Spinner size={28} />
            </div>
          )}
        </div>
        <div className="flex flex-col items-center gap-3">
          <div className="text-[clamp(28px,2.6vw,52px)] font-black">
            {title}
            {progress !== null && <span className="num ml-3 text-accent">{Math.round(progress * 100)}%</span>}
          </div>
          <div className="text-[clamp(18px,1.4vw,28px)] text-fg-2">
            {song.name} · {artistsText(song)}
          </div>
          {detail && <div className={clsx('text-base', tone === 'warn' ? 'text-warn' : 'text-muted')}>{detail}</div>}
          {progress !== null && <ProgressBar value={progress} color="#FF4D7E" className="mt-3 h-1.5 w-[32vw] max-w-[520px]" />}
          {waitingForMain && longWait && (
            <div className="mt-3">
              <ScreenRoleControl onMakeMain={onMakeMain!} compact />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/** True when `on` has stayed true for `ms` (hides flicker on fast loads). */
export function useDelayedFlag(on: boolean, ms: number) {
  const [v, setV] = useState(false)
  useEffect(() => {
    if (!on) {
      setV(false)
      return
    }
    const t = window.setTimeout(() => setV(true), ms)
    return () => window.clearTimeout(t)
  }, [on, ms])
  return v
}

/** A fresh song shows the 即将开始 card at least this long before it starts… */
export const START_HOLD_MS = 2400

/** …and waits for its lyrics at most this long. */
export const START_MAX_WAIT_MS = 6000

/** 即将开始: the song is loaded; it starts when the dots run out. */
export function StartingScreen({ song, singer, since }: { song: Song; singer?: string; since: number }) {
  const [left, setLeft] = useState(3)
  useEffect(() => {
    const tick = () => setLeft(Math.max(1, 3 - Math.floor(((performance.now() - since) / START_HOLD_MS) * 3)))
    tick()
    const t = window.setInterval(tick, 100)
    return () => window.clearInterval(t)
  }, [since])
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.98 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.4 }}
      className="absolute inset-0 flex items-center justify-center px-[4vw]"
    >
      <div className="flex flex-col items-center gap-8 text-center">
        <Cover song={song} px={600} className="h-[34vh] w-[34vh] rounded-[32px] shadow-[0_30px_80px_rgba(0,0,0,0.55)]" />
        <div className="flex flex-col items-center gap-3">
          <div className="text-[clamp(28px,2.6vw,52px)] font-black">即将开始</div>
          <div className="text-[clamp(18px,1.4vw,28px)] text-fg-2">
            {song.name} · {artistsText(song)}
          </div>
          {singer && <div className="text-base text-muted">演唱：{singer}</div>}
          <div className="mt-3 flex gap-3" aria-hidden="true">
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                className="h-3 w-3 rounded-full bg-accent transition-opacity duration-300"
                style={{ opacity: i < left ? 1 : 0, boxShadow: '0 0 12px rgba(255,77,126,0.8)' }}
              />
            ))}
          </div>
        </div>
      </div>
    </motion.div>
  )
}

/** Seconds before the end of a song when the "接下来" panel slides in. */
/** The "接下来" panel only appears after this fraction of the song… */
export const UP_NEXT_FROM = 0.85

/** …and then alternates: shown for UP_NEXT_ON seconds, hidden for UP_NEXT_OFF seconds. */
export const UP_NEXT_ON = 30

export const UP_NEXT_OFF = 30

/** Always shown during the final seconds, whatever the 30 s on / off cycle says. */
export const UP_NEXT_FINAL = 10

/** Whether the "接下来" panel should be visible at `pos` seconds of a `duration`-second song. */
export function upNextVisible(pos: number, duration: number): boolean {
  if (!(duration > 0)) return false
  const since = pos - duration * UP_NEXT_FROM
  if (since < 0) return false
  if (duration - pos <= UP_NEXT_FINAL) return true
  return since % (UP_NEXT_ON + UP_NEXT_OFF) < UP_NEXT_ON
}

export const UP_NEXT_MAX = 5

/**
 * Right-edge panel listing the next songs (and who requested them) near the end of a song,
 * so the next singers can get ready. Ignores idle auto-hide. In MV mode it sits higher so it
 * never covers the two lyric lines at the bottom.
 */
export function UpNextPanel({ shown, mvMode }: { shown: boolean; mvMode: boolean }) {
  const queue = useApp((s) => s.state.queue)
  const tracks = useApp((s) => s.state.tracks)
  const reduce = useReducedMotion()
  const items = queue.slice(0, UP_NEXT_MAX)
  const more = queue.length - items.length
  return (
    <AnimatePresence>
      {shown && items.length > 0 && (
        <motion.aside
          key="up-next"
          aria-label="接下来"
          aria-live="polite"
          initial={reduce ? { opacity: 0 } : { opacity: 0, x: 48 }}
          animate={reduce ? { opacity: 1 } : { opacity: 1, x: 0 }}
          exit={reduce ? { opacity: 0 } : { opacity: 0, x: 48 }}
          transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
          className={clsx(
            'pointer-events-none absolute right-[2.6vw] z-20 flex w-[min(420px,28vw)] min-w-[300px] flex-col',
            // Stage: between the header and the control bar. MV: clear of the bottom lyric lines.
            mvMode ? 'top-[13vh] bottom-[34vh]' : 'top-[29vh] bottom-[27vh]',
            'justify-center',
          )}
        >
          <div className="glass flex max-h-full min-h-0 flex-col gap-3 overflow-hidden rounded-[28px] p-4 shadow-[0_30px_80px_rgba(0,0,0,0.55)]">
            <div className="flex shrink-0 items-center justify-between px-1">
              <span className="flex items-center gap-2 text-[clamp(16px,1vw,22px)] font-bold tracking-[0.18em] whitespace-nowrap text-fg">
                <Icon name="list" size={18} className="text-accent" />
                接下来
              </span>
              <span className="text-[clamp(14px,0.85vw,18px)] whitespace-nowrap text-muted">{queue.length} 首待唱</span>
            </div>
            <ol className="m-0 flex min-h-0 list-none flex-col gap-1.5 overflow-hidden p-0 [mask-image:linear-gradient(180deg,#000_85%,transparent)]">
              {items.map((item, i) => {
                const first = i === 0
                const status = deriveStatus(item.song, tracks[item.song.id], true)
                return (
                  <motion.li
                    key={item.uid}
                    initial={reduce ? false : { opacity: 0, x: 24 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: reduce ? 0 : 0.08 + i * 0.05, duration: 0.35 }}
                    className={clsx(
                      'flex shrink-0 items-center gap-3 rounded-2xl',
                      first
                        ? 'border border-[rgba(255,77,126,0.45)] bg-[linear-gradient(135deg,rgba(255,77,126,0.24),rgba(123,47,247,0.16))] p-3 shadow-[0_0_30px_rgba(255,77,126,0.22)]'
                        : 'px-3 py-2',
                    )}
                  >
                    {first ? (
                      <Cover song={item.song} px={160} className="h-14 w-14 rounded-xl" />
                    ) : (
                      <span className="num w-7 shrink-0 text-center text-[clamp(16px,1vw,22px)] text-subtle">{i + 1}</span>
                    )}
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      {first && (
                        <span className="text-[clamp(14px,0.85vw,18px)] font-semibold tracking-[0.14em] whitespace-nowrap text-[#FFC2D1]">
                          下一首
                        </span>
                      )}
                      <span className={clsx('truncate font-semibold', first ? 'text-[clamp(19px,1.25vw,28px)]' : 'text-[clamp(16px,1vw,22px)]')}>
                        {item.song.name}
                      </span>
                      <span className="truncate text-[clamp(14px,0.85vw,18px)] text-fg-2">
                        {artistsText(item.song)}
                        {singerOf(item.addedBy) && <span className="text-[#FFC2D1]"> · 由 {item.addedBy} 点歌</span>}
                      </span>
                    </div>
                    {first && (
                      <span className="shrink-0">
                        <StatusPill status={status} />
                      </span>
                    )}
                  </motion.li>
                )
              })}
            </ol>
            {more > 0 && <div className="shrink-0 px-1 text-[clamp(14px,0.85vw,18px)] whitespace-nowrap text-muted">还有 {more} 首…</div>}
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  )
}
