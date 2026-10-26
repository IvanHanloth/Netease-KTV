import { useEffect, useRef, useState, type MutableRefObject, type ReactNode } from 'react'
import clsx from 'clsx'
import type { DisplayMode, PlayerState, Song, TrackState } from '@shared/types'
import { artistsText, deriveStatus, fmtTime, keyText } from '../../lib/format'
import { useIsLocalhostOrigin, useRemoteUrl } from '../../lib/hooks'
import type { MicError } from '../../player/mic'
import { sendCommand, useApp } from '../../store/app'
import { Icon, type IconName } from '../../components/icons'
import { Cover, ProgressBar, Range, Spinner, StatusPill } from '../../components/ui'
import { QrCode } from '../../components/QrCode'
import { DisplayModeToggle, TrackModeToggle } from '../../components/PlayerModes'
import { useLyrics } from './lyrics'
import { KEY_MAX, KEY_MIN, singerName } from '@shared/constants'

/** 大屏 header, control bar and the small controls in it (mixer, key, 主屏 role, scoring, QR card). */

export function Chip({ children, icon, accent }: { children: ReactNode; icon?: IconName; accent?: boolean }) {
  return (
    <span
      className={clsx(
        'inline-flex h-[30px] items-center gap-1.5 rounded-full border px-3 text-[15px] whitespace-nowrap',
        accent ? 'border-accent/40 bg-accent/15 text-[#FFC2D1]' : 'border-white/10 bg-white/8 text-[#E4E4EA]',
      )}
    >
      {icon && <Icon name={icon} size={16} />}
      {children}
    </span>
  )
}

/** The requester's nickname, unless it is the anonymous default. */
export const singerOf = singerName

export const fadeCls = (shown: boolean) =>
  clsx(
    'transition-[opacity,transform] duration-500 motion-reduce:transition-none',
    shown ? 'opacity-100' : 'pointer-events-none translate-y-2 opacity-0',
  )

export function Header({
  player,
  track,
  auxShown,
  hideNext,
}: {
  player: PlayerState
  track?: TrackState
  auxShown: boolean
  /** The 接下来 panel is showing the queue: don't repeat the next song here. */
  hideNext: boolean
}) {
  const cur = player.current!
  const singer = singerOf(cur.addedBy)
  const queue = useApp((s) => s.state.queue)
  const tracks = useApp((s) => s.state.tracks)
  const { data: lyrics } = useLyrics(cur.song.id)
  const next = queue[0]
  const nextStatus = next ? deriveStatus(next.song, tracks[next.song.id], true) : null
  const working = queue.find((q) => {
    const st = tracks[q.song.id]?.status
    return st === 'separating' || st === 'downloading'
  })
  const workingTrack = working ? tracks[working.song.id] : undefined
  const karaoke = player.trackMode === 'karaoke' && track?.hasStems
  return (
    <header className="absolute top-[calc(5.2vh+var(--tb-h))] right-[3.75vw] left-[3.75vw] flex items-start justify-between gap-8">
      <div className="flex min-w-0 items-center gap-6">
        <Cover song={cur.song} px={300} className="h-24 w-24 rounded-[18px] shadow-[0_18px_40px_rgba(0,0,0,0.45)]" />
        <div className="flex min-w-0 flex-col gap-2">
          <h1 className="m-0 truncate text-[34px] font-bold tracking-[0.01em]">{cur.song.name}</h1>
          <div className="truncate text-xl text-[#B4B4BE]">
            {artistsText(cur.song)}
            {cur.song.album.name && ` · ${cur.song.album.name}`}
          </div>
          <div className="mt-1.5 flex flex-wrap gap-2.5">
            {singer && (
              <Chip icon="user" accent>
                {singer}
              </Chip>
            )}
            {karaoke ? (player.leadVocal ? <Chip icon="note">领唱</Chip> : <Chip icon="wave">伴唱</Chip>) : <Chip icon="mic">原唱</Chip>}
            {lyrics?.kind === 'yrc' && <Chip icon="lyrics">逐字歌词</Chip>}
            {track?.source === 'unblock' && <Chip icon="globe">第三方音源</Chip>}
            {player.key !== 0 && <Chip>{keyText(player.key)}</Chip>}
          </div>
        </div>
      </div>
      <div className={clsx('flex shrink-0 flex-col items-end gap-4', fadeCls(auxShown))}>
        <QrCard />
        {next && nextStatus && !hideNext && (
          <div className="glass flex items-center gap-4 rounded-[20px] py-3.5 pr-5 pl-3.5">
            <Cover song={next.song} px={120} className="h-14 w-14 rounded-xl" />
            <div className="flex max-w-[22vw] min-w-0 flex-col gap-1">
              <div className="text-sm tracking-[0.12em] text-muted">下一首</div>
              <div className="truncate text-xl font-semibold">
                {next.song.name} <span className="font-normal text-[#B4B4BE]">· {artistsText(next.song)}</span>
              </div>
            </div>
            <span className="ml-2">
              <StatusPill status={nextStatus} large />
            </span>
          </div>
        )}
        <div className="flex items-center gap-3 text-base text-[#B4B4BE]">
          {working && workingTrack && (
            <>
              <Icon name="sparkles" size={18} className="text-accent" />
              <span className="max-w-[18vw] truncate">
                {workingTrack.status === 'downloading' ? '下载中' : 'AI 伴奏分离'} · {working.song.name}
              </span>
              <ProgressBar value={workingTrack.progress} color="#FF4D7E" className="w-[120px]" />
              <span className="num text-[#E4E4EA]">{Math.round(workingTrack.progress * 100)}%</span>
              <span className="text-faint">|</span>
            </>
          )}
          <span>已点 {queue.length + 1} 首</span>
        </div>
      </div>
    </header>
  )
}

/** MV mode: song title in the corner, shown briefly when a song starts (and while the UI is awake). */
export function MvTitle({ song, singer, shown }: { song: Song; singer?: string; shown: boolean }) {
  return (
    <div className={clsx('absolute top-[calc(5.2vh+var(--tb-h))] left-[3.75vw] flex max-w-[60vw] items-center gap-4', fadeCls(shown))}>
      <Cover song={song} px={160} className="h-16 w-16 rounded-2xl shadow-[0_12px_30px_rgba(0,0,0,0.5)]" />
      <div className="flex min-w-0 flex-col gap-1" style={{ filter: 'drop-shadow(0 2px 10px rgba(0,0,0,0.85))' }}>
        <span className="truncate text-[30px] leading-tight font-bold">{song.name}</span>
        <span className="truncate text-lg text-fg-2">
          {artistsText(song)}
          {singer && <span className="font-semibold text-[#FFC2D1]"> · {singer} 演唱</span>}
        </span>
      </div>
    </div>
  )
}

export function Progress({ getPos, duration }: { getPos: () => number; duration: number }) {
  const [pos, setPos] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setPos(getPos()), 250)
    return () => clearInterval(t)
  }, [getPos])
  const pct = duration ? Math.min(100, (pos / duration) * 100) : 0
  return (
    <div className="num flex items-center gap-5 text-lg text-[#C8C8D0]">
      <span>{fmtTime(pos)}</span>
      <div
        role="slider"
        tabIndex={-1}
        aria-label="播放进度"
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={Math.round(pos)}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          sendCommand({ action: 'seek', position: ((e.clientX - r.left) / r.width) * duration })
        }}
        className="relative h-1.5 flex-1 cursor-pointer rounded-full bg-white/14"
      >
        <div
          className="absolute inset-y-0 left-0 rounded-full"
          style={{ width: pct + '%', background: 'linear-gradient(90deg, #FF4D7E 0%, #FFB3C6 100%)', boxShadow: '0 0 16px #FF4D7E' }}
        />
      </div>
      <span>{fmtTime(duration)}</span>
    </div>
  )
}

export type SetPatch = Omit<Extract<Parameters<typeof sendCommand>[0], { action: 'set' }>, 'action'>

export const setPlayer = (patch: SetPatch) => sendCommand({ action: 'set', ...patch })

export function ControlPill({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={clsx('glass flex h-14 shrink-0 items-center gap-2.5 rounded-[18px] px-4 whitespace-nowrap', className)}>
      {children}
    </div>
  )
}

export function BarButton({
  icon,
  label,
  title,
  onClick,
  primary,
  text,
}: {
  icon: IconName
  label: string
  title?: string
  onClick: () => void
  primary?: boolean
  /** Visible label, shown from xl up. */
  text?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={title ?? label}
      className={clsx(
        'flex shrink-0 items-center justify-center gap-2 whitespace-nowrap transition-[transform,background-color]',
        primary
          ? 'h-14 w-14 rounded-full bg-accent text-accent-ink shadow-[0_10px_28px_rgba(255,77,126,0.45)] hover:scale-105'
          : clsx('glass h-14 rounded-[18px] hover:bg-white/10', text ? 'min-w-14 px-4 text-[15px]' : 'w-14'),
      )}
    >
      <Icon name={icon} size={primary ? 24 : 20} />
      {text && <span className="hidden xl:inline">{text}</span>}
    </button>
  )
}

/** Volume summary pill; the sliders live in a popover so the bar never grows. */
export function MixerButton({
  player,
  karaoke,
  open,
  onToggle,
}: {
  player: PlayerState
  karaoke: boolean
  open: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-haspopup="dialog"
      title="音量"
      className={clsx(
        'glass flex h-14 shrink-0 items-center gap-2.5 rounded-[18px] px-4 text-[15px] whitespace-nowrap transition-colors hover:bg-white/10',
        open && 'bg-white/12',
      )}
    >
      <Icon name="volume" size={20} />
      <span className="hidden min-[1440px]:inline">{karaoke ? '伴奏' : '音量'}</span>
      <span className="num text-[#E4E4EA]">{Math.round(player.musicVolume * 100)}%</span>
    </button>
  )
}

export function MixerPopover({ player, karaoke }: { player: PlayerState; karaoke: boolean }) {
  const row = (icon: IconName, label: string, value: number, onChange: (v: number) => void) => (
    <div className="flex items-center gap-3">
      <Icon name={icon} size={18} className="shrink-0 text-fg-2" />
      <span className="w-12 shrink-0 text-[15px] whitespace-nowrap">{label}</span>
      <div className="min-w-0 flex-1">
        <Range label={label + '音量'} value={Math.round(value * 100)} onChange={(v) => onChange(v / 100)} color="#FFFFFF" />
      </div>
      <span className="num w-11 shrink-0 text-right text-[15px] text-[#C8C8D0]">{Math.round(value * 100)}%</span>
    </div>
  )
  return (
    <div
      role="dialog"
      aria-label="音量"
      className="glass flex w-[340px] flex-col gap-4 rounded-[20px] p-5 shadow-[0_24px_60px_rgba(0,0,0,0.55)]"
    >
      {row('volume', karaoke ? '伴奏' : '音量', player.musicVolume, (v) => setPlayer({ musicVolume: v }))}
    </div>
  )
}

export function KeyControl({ value, pending }: { value: number; pending?: boolean }) {
  return (
    <ControlPill className="pr-2 pl-4">
      <span className="text-[15px] text-fg-2 min-[1440px]:hidden">{pending ? '变调' : '调'}</span>
      <span className="hidden text-[15px] min-[1440px]:inline">{pending ? '变调中' : '升降调'}</span>
      <button
        type="button"
        aria-label="降调"
        disabled={value <= KEY_MIN}
        onClick={() => setPlayer({ key: value - 1 })}
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white/8 hover:bg-white/14 disabled:opacity-40"
      >
        <Icon name="minus" size={18} strokeWidth={2} />
      </button>
      <span
        className="num relative flex w-9 items-center justify-center text-[20px] font-semibold text-accent"
        aria-live="polite"
        title={pending ? '正在处理变调，几秒后生效' : '当前调'}
      >
        <span className={clsx(pending && 'opacity-40')}>{value > 0 ? '+' + value : value}</span>
        {pending && (
          <span className="absolute inset-0 flex items-center justify-center text-fg">
            <Spinner size={18} />
          </span>
        )}
      </span>
      <button
        type="button"
        aria-label="升调"
        disabled={value >= KEY_MAX}
        onClick={() => setPlayer({ key: value + 1 })}
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white/8 hover:bg-white/14 disabled:opacity-40"
      >
        <Icon name="plus" size={18} strokeWidth={2} />
      </button>
    </ControlPill>
  )
}

/**
 * One-row TV control bar: transport · modes · (spacer) · mixer / key / scoring.
 * Never wraps: labels collapse to icons below 1280 px, and below 1024 px the row scrolls
 * sideways. Popovers render outside the scrolling row so they are never clipped.
 */
export function Controls({
  player,
  hasStems,
  extra,
  keyPending,
  mirror,
}: {
  player: PlayerState
  hasStems: boolean
  extra?: ReactNode
  keyPending?: boolean
  /** A 大屏 that isn't the 主屏: its 舞台 / MV mode (own one unless 多大屏协同), 设为主屏, mute. */
  mirror?: {
    displayMode: DisplayMode
    setDisplayMode: (m: DisplayMode) => void
    takeOver: () => void
    muted?: boolean
    toggleMute?: () => void
    volume?: number
    setVolume?: (v: number) => void
  }
}) {
  const karaoke = hasStems && player.trackMode === 'karaoke'
  const [mixerOpen, setMixerOpen] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!mixerOpen) return
    const onDown = (e: PointerEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setMixerOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMixerOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [mixerOpen])

  return (
    <div ref={boxRef} className="relative min-w-0">
      {mixerOpen && (
        <div className="absolute right-0 bottom-full z-20 mb-3">
          <MixerPopover player={player} karaoke={karaoke} />
        </div>
      )}
      <div className="flex min-w-0 flex-nowrap items-center gap-3 max-lg:overflow-x-auto max-lg:pb-1">
        <BarButton
          primary
          icon={player.playing ? 'pause' : 'play'}
          label={player.playing ? '暂停' : '播放'}
          title={player.playing ? '暂停（空格）' : '播放（空格）'}
          onClick={() => sendCommand({ action: 'toggle' })}
        />
        <BarButton icon="replay" label="重唱" onClick={() => sendCommand({ action: 'restart' })} />
        <BarButton icon="next" label="切歌" title="切歌（N）" text="切歌" onClick={() => sendCommand({ action: 'next' })} />
        <span className="mx-1 h-8 w-px shrink-0 bg-white/12" aria-hidden="true" />
        <TrackModeToggle size="tv" />
        {mirror ? (
          <DisplayModeToggle size="tv" value={mirror.displayMode} onChange={mirror.setDisplayMode} />
        ) : (
          <DisplayModeToggle size="tv" />
        )}
        <span className="min-w-2 flex-1" aria-hidden="true" />
        {mirror ? (
          <ScreenRoleControl
            onMakeMain={mirror.takeOver}
            muted={mirror.muted}
            onToggleMute={mirror.toggleMute}
            volume={mirror.volume}
            onVolume={mirror.setVolume}
            confirm
          />
        ) : (
          <>
            <MixerButton player={player} karaoke={karaoke} open={mixerOpen} onToggle={() => setMixerOpen((v) => !v)} />
            <KeyControl value={player.key} pending={keyPending} />
            {extra}
          </>
        )}
      </div>
    </div>
  )
}

const SCREEN_VOLUME_PREF = 'ktv.screenVolume'

/** This 大屏's own volume (used while it isn't the 主屏), 0..1; remembered per device. */
export function readScreenVolume() {
  try {
    const v = Number(localStorage.getItem(SCREEN_VOLUME_PREF))
    return localStorage.getItem(SCREEN_VOLUME_PREF) !== null && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 1
  } catch {
    return 1
  }
}

export function saveScreenVolume(v: number) {
  try {
    localStorage.setItem(SCREEN_VOLUME_PREF, String(v))
  } catch {
    /* storage unavailable */
  }
}

/** A 大屏 that isn't the 主屏: 设为主屏, and (with 多大屏播放) its own mute switch and volume. */
export function ScreenRoleControl({
  onMakeMain,
  muted,
  onToggleMute,
  volume,
  onVolume,
  compact,
  confirm,
}: {
  onMakeMain: () => void
  /** undefined: 多大屏播放 is off, there is nothing to toggle. */
  muted?: boolean
  onToggleMute?: () => void
  /** This screen's own volume (0..1), adjustable once it is unmuted. */
  volume?: number
  onVolume?: (v: number) => void
  compact?: boolean
  /** A song is playing: switching moves the sound, so ask for a second press. */
  confirm?: boolean
}) {
  const h = compact ? 'h-12 rounded-2xl' : 'h-14 rounded-[18px]'
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!armed) return
    const t = window.setTimeout(() => setArmed(false), 3000)
    return () => window.clearTimeout(t)
  }, [armed])
  const makeMain = () => {
    if (confirm && !armed) {
      setArmed(true)
      return
    }
    setArmed(false)
    onMakeMain()
  }
  return (
    <div className="flex shrink-0 items-center gap-3">
      {onToggleMute &&
        (!muted && volume !== undefined && onVolume ? (
          // Unmuted: the speaker button mutes again, the slider sets this screen's own volume.
          <div className={clsx('glass flex shrink-0 items-center gap-3 pr-4 pl-1.5 text-[15px] whitespace-nowrap', h)}>
            <button
              type="button"
              onClick={onToggleMute}
              aria-label="这块大屏静音"
              title="这块大屏静音"
              className={clsx(
                'flex shrink-0 items-center justify-center text-fg-2 hover:bg-white/10 hover:text-fg',
                compact ? 'h-9 w-9 rounded-xl' : 'h-11 w-11 rounded-[14px]',
              )}
            >
              <Icon name={volume > 0 ? 'volume' : 'volumeOff'} size={19} />
            </button>
            <div className={compact ? 'w-28' : 'w-36'}>
              <Range
                label="这块大屏的音量"
                value={Math.round(volume * 100)}
                onChange={(v) => onVolume(v / 100)}
                color="#FFFFFF"
              />
            </div>
            <span className="num w-10 shrink-0 text-right text-[#C8C8D0]">{Math.round(volume * 100)}%</span>
          </div>
        ) : (
          <button
            type="button"
            onClick={onToggleMute}
            title={muted ? '这块大屏也发声（和主屏同步）' : '这块大屏静音'}
            className={clsx('glass flex shrink-0 items-center gap-2 px-4 text-[15px] whitespace-nowrap text-fg-2 hover:bg-white/10', h)}
          >
            <Icon name={muted ? 'volumeOff' : 'volume'} size={18} className={muted ? 'opacity-50' : undefined} />
            {muted ? '取消静音' : '静音'}
          </button>
        ))}
      <button
        type="button"
        onClick={makeMain}
        title="设为主屏：由这块大屏发声，点歌台和手机遥控改为控制它"
        className={clsx(
          'flex shrink-0 items-center gap-2 px-5 text-[15px] font-semibold whitespace-nowrap transition-colors',
          armed ? 'bg-accent text-accent-ink' : 'glass border border-accent/50 text-accent-soft hover:bg-accent/15',
          h,
        )}
      >
        <Icon name="tv" size={19} />
        {armed ? '再按一次确认' : '设为主屏'}
      </button>
    </div>
  )
}

export const SCORE_PREF = 'ktv.scoring'

export function readScorePref() {
  try {
    return localStorage.getItem(SCORE_PREF) === '1'
  } catch {
    return false
  }
}

export type ScoringStatus = 'off' | 'loading' | 'on' | 'error'

/** Why scoring isn't working, if it isn't (null: fine, or off). */
export function scoreHint(o: { on: boolean; hasPitch: boolean; status: ScoringStatus; micError: MicError | null; pitchError: boolean }) {
  if (!o.on) return null
  if (!window.isSecureContext || o.micError === 'insecure') return '麦克风需要通过 localhost 或 HTTPS 打开大屏'
  if (o.micError === 'denied') return '麦克风权限被拒绝，请在浏览器里允许'
  if (o.micError === 'unavailable') return '没有找到可用的麦克风'
  if (!o.hasPitch) return '这首歌暂无参考音高（需要伴奏分离）'
  if (o.pitchError) return '参考音高加载失败'
  if (o.status === 'loading') return '正在打开麦克风…'
  return null
}

export function ScoreToggle({
  on,
  onToggle,
  hasPitch,
  status,
  micError,
  pitchError,
}: {
  on: boolean
  onToggle: () => void
  hasPitch: boolean
  status: ScoringStatus
  micError: MicError | null
  pitchError: boolean
}) {
  const hint = scoreHint({ on, hasPitch, status, micError, pitchError })
  return (
    <div className="relative shrink-0">
      {hint && (
        <div className="glass absolute right-0 bottom-full mb-3 w-max max-w-[300px] rounded-xl px-3.5 py-2 text-[13px] leading-5 text-warn shadow-[0_12px_30px_rgba(0,0,0,0.45)]">
          {hint}
        </div>
      )}
      <button
        type="button"
        aria-pressed={on}
        onClick={onToggle}
        title={hint ?? (on ? '关闭评分' : '打开评分')}
        className={clsx(
          'flex h-14 shrink-0 items-center gap-2 rounded-[18px] px-4 text-[15px] whitespace-nowrap transition-colors',
          on ? 'bg-accent font-semibold text-accent-ink' : 'glass text-fg hover:bg-white/10',
        )}
      >
        <Icon name="mic" size={20} />
        评分
        {hint && <span className="h-2 w-2 rounded-full bg-warn" aria-hidden="true" />}
      </button>
    </div>
  )
}

export function QrCard({ big }: { big?: boolean }) {
  const url = useRemoteUrl()
  const localhost = useIsLocalhostOrigin()
  const display = url.replace(/^https?:\/\//, '').replace(/\?.*$/, '')
  return (
    <div className={clsx('glass flex items-center rounded-3xl', big ? 'gap-8 p-6 pr-10' : 'gap-5.5 p-4.5 pr-6.5')}>
      {localhost ? (
        <div
          aria-hidden="true"
          className="flex shrink-0 items-center justify-center rounded-2xl bg-white/6 text-warn"
          style={{ width: big ? 220 : 132, height: big ? 220 : 132 }}
        >
          <Icon name="alert" size={big ? 56 : 36} />
        </div>
      ) : (
        <QrCode value={url} size={big ? 220 : 132} label="扫码点歌二维码" />
      )}
      <div className="flex flex-col gap-1.5">
        <div className={clsx('font-bold whitespace-nowrap', big ? 'text-[34px]' : 'text-2xl')}>扫码点歌</div>
        <div className={clsx('whitespace-nowrap text-[#B4B4BE]', big ? 'text-lg' : 'text-base')}>同一 Wi‑Fi 下用手机扫描</div>
        {!localhost && (
          <div className={clsx('num mt-1.5 font-medium whitespace-nowrap text-accent', big ? 'text-xl' : 'text-[17px]')}>{display}</div>
        )}
        {localhost && (
          <div className={clsx('mt-1 max-w-[320px] leading-6 text-warn', big ? 'text-lg' : 'text-base')}>
            当前通过 localhost 打开，手机无法访问。请在后台管理（/admin）的“网络”里填写局域网地址。
          </div>
        )}
      </div>
    </div>
  )
}

/** Footer control bar that fades out when idle; hovering it keeps it awake. */
export function ControlsArea({
  holdRef,
  hoverRef,
  shown,
  children,
}: {
  holdRef: MutableRefObject<HTMLDivElement | null>
  hoverRef: MutableRefObject<boolean>
  shown: boolean
  children: ReactNode
}) {
  return (
    <div
      ref={holdRef}
      onPointerEnter={() => (hoverRef.current = true)}
      onPointerLeave={() => (hoverRef.current = false)}
      className={clsx('flex items-end gap-10', fadeCls(shown))}
    >
      {children}
    </div>
  )
}
