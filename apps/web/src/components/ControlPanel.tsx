import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import clsx from 'clsx'
import type { DisplayMode, MicErrorCode, PlayerCommand, ScreenInfo } from '@shared/types'
import { KEY_MAX, KEY_MIN } from '@shared/constants'
import { artistsText, fmtTime } from '../lib/format'
import { useSettings } from '../lib/hooks'
import { livePosition, sendCommand, sendScreenCommand, useApp } from '../store/app'
import { Icon, type IconName } from './icons'
import { DisplayModeToggle, TrackModeToggle } from './PlayerModes'
import { Cover, ProgressBar, Range, Switch } from './ui'

/**
 * 点歌台 控制台: everything the 大屏 control bar can do, plus the 大屏 themselves.
 *
 * Two layers, so it is always clear what a control acts on:
 *  - the selected 大屏 (tabs at the top): 定位, 设为主屏, its 舞台 / MV mode, its own sound;
 *  - the singing itself, which always happens on the 主屏: transport, 演唱模式, key, volumes,
 *    microphone and 评分 (shared player values, so every 点歌台 and remote stays in step).
 */

const set = (patch: Omit<Extract<PlayerCommand, { action: 'set' }>, 'action'>) => sendCommand({ action: 'set', ...patch })

/** A slider bound to a live value: local while dragging, throttled sends, then follows the shared value. */
function useLive(remote: number, apply: (v: number) => void) {
  const [local, setLocal] = useState<number | null>(null)
  const last = useRef(0)
  const timer = useRef<number | undefined>(undefined)
  const idle = useRef<number | undefined>(undefined)
  const applyRef = useRef(apply)
  applyRef.current = apply
  const change = useCallback((v: number) => {
    setLocal(v)
    window.clearTimeout(timer.current)
    const now = Date.now()
    if (now - last.current > 120) {
      last.current = now
      applyRef.current(v)
    } else {
      timer.current = window.setTimeout(() => {
        last.current = Date.now()
        applyRef.current(v)
      }, 120)
    }
    window.clearTimeout(idle.current)
    idle.current = window.setTimeout(() => setLocal(null), 800)
  }, [])
  return [local ?? remote, change] as const
}

function useNow(interval: number) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), interval)
    return () => window.clearInterval(t)
  }, [interval])
  return now
}

// ---------------- launcher ----------------

/** The button under the 已点 list, and the floating panel it opens next to it. */
export function ControlPanelLauncher() {
  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const screens = useApp((s) => s.screens)
  const main = screens.find((s) => s.main)

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (panelRef.current?.contains(t) || btnRef.current?.contains(t)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false)
        btnRef.current?.focus()
      }
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const status = !screens.length
    ? '大屏未打开'
    : main
      ? `大屏 ${main.number} 为主屏${screens.length > 1 ? ` · 共 ${screens.length} 块大屏` : ''}`
      : `${screens.length} 块大屏`

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
        className={clsx(
          'group flex w-full items-center gap-3.5 rounded-[20px] border p-3 pr-4 text-left transition-colors',
          open ? 'border-accent/50 bg-accent/10' : 'border-white/10 bg-white/[0.04] hover:bg-white/[0.07]',
        )}
      >
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[14px] bg-[linear-gradient(135deg,#FF4D7E_0%,#8B5CF6_100%)] text-white shadow-[0_8px_24px_rgba(139,92,246,0.35)]">
          <Icon name="sliders" size={21} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-[15px] font-semibold">控制台</span>
          <span className={clsx('flex items-center gap-1.5 truncate text-xs', screens.length ? 'text-muted' : 'text-warn')}>
            <span className={clsx('h-1.5 w-1.5 shrink-0 rounded-full', screens.length ? 'bg-ok-dot' : 'bg-warn-dot')} />
            {status}
          </span>
        </span>
        <Icon
          name="chevronLeft"
          size={18}
          className={clsx('shrink-0 text-muted transition-transform duration-300', open ? '-rotate-90' : 'rotate-90')}
        />
      </button>
      <AnimatePresence>
        {open && (
          <FloatingPanel anchor={btnRef} panelRef={panelRef} onClose={() => setOpen(false)}>
            <ControlPanel onClose={() => setOpen(false)} />
          </FloatingPanel>
        )}
      </AnimatePresence>
    </>
  )
}

/**
 * Fixed to the viewport, right-aligned with the button and just above it; beside it when there is
 * no room above; a bottom sheet on phones.
 */
function FloatingPanel({
  anchor,
  panelRef,
  onClose,
  children,
}: {
  anchor: React.RefObject<HTMLButtonElement | null>
  panelRef: React.RefObject<HTMLDivElement | null>
  onClose: () => void
  children: ReactNode
}) {
  const [style, setStyle] = useState<CSSProperties>({ right: 16, bottom: 16 })
  const [sheet, setSheet] = useState(false)
  useLayoutEffect(() => {
    const place = () => {
      const vw = window.innerWidth
      const vh = window.innerHeight
      if (vw < 640) {
        setSheet(true)
        setStyle({ left: 8, right: 8, bottom: 8, maxHeight: Math.round(vh * 0.86) })
        return
      }
      setSheet(false)
      const r = anchor.current?.getBoundingClientRect()
      const gap = 12
      if (!r || r.bottom < 0 || r.top > vh) {
        setStyle({ right: 16, bottom: 16, maxHeight: vh - 32 })
        return
      }
      const right = Math.max(16, vw - r.right)
      const above = r.top - gap - 16
      if (above >= 460) {
        setStyle({ right, bottom: vh - r.top + gap, maxHeight: Math.min(800, above) })
      } else {
        // Not enough room above the button: to its left, bottom-aligned with it.
        setStyle({ right: Math.max(16, vw - r.left + gap), bottom: Math.max(16, vh - r.bottom), maxHeight: Math.min(800, vh - 32) })
      }
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [anchor])
  useEffect(() => {
    panelRef.current?.focus({ preventScroll: true })
  }, [panelRef])
  return (
    <>
      {sheet && (
        <motion.div
          aria-hidden="true"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
          className="fixed inset-0 z-40 bg-black/50 backdrop-blur-[2px]"
        />
      )}
      <motion.div
        ref={panelRef}
        role="dialog"
        aria-label="控制台"
        tabIndex={-1}
        initial={{ opacity: 0, y: 14, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 10, scale: 0.98 }}
        transition={{ type: 'spring', stiffness: 420, damping: 34, mass: 0.8 }}
        style={{ ...style, transformOrigin: 'bottom right' }}
        className={clsx(
          'fixed z-50 flex flex-col overflow-hidden border border-white/10 bg-[#15151D]/95 text-fg shadow-[0_30px_80px_rgba(0,0,0,0.6),0_0_0_1px_rgba(255,255,255,0.02)] backdrop-blur-xl outline-none',
          sheet ? 'rounded-[26px]' : 'w-[408px] rounded-[26px]',
        )}
      >
        {children}
      </motion.div>
    </>
  )
}

// ---------------- the panel ----------------

function ControlPanel({ onClose }: { onClose: () => void }) {
  const screens = useApp((s) => s.screens)
  const main = screens.find((s) => s.main) ?? null
  const [selectedId, setSelectedId] = useState<number | null>(null)
  // The 主屏 unless another one was picked (and is still open).
  const selected = screens.find((s) => s.id === selectedId) ?? main ?? screens[0] ?? null

  return (
    <>
      <header className="flex flex-col gap-3 border-b border-white/6 px-4 pt-4 pb-3">
        <div className="flex items-center justify-between pl-1">
          <span className="text-[17px] font-bold">控制台</span>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭控制台"
            className="flex h-9 w-9 items-center justify-center rounded-xl text-muted hover:bg-white/8 hover:text-fg"
          >
            <Icon name="x" size={18} />
          </button>
        </div>
        {screens.length > 0 && <ScreenTabs screens={screens} selected={selected} onSelect={(s) => setSelectedId(s.id)} />}
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto overscroll-contain px-4 pt-4 pb-5">
        {selected ? <ScreenCard screen={selected} /> : <NoScreen />}
        <div className="flex items-center gap-3 px-1 text-[11px] font-semibold tracking-[0.16em] text-faint">
          <span className="h-px flex-1 bg-white/8" />
          {main ? `演唱控制 · 大屏 ${main.number}（主屏）` : '演唱控制'}
          <span className="h-px flex-1 bg-white/8" />
        </div>
        <NowPlaying />
        <ModesAndKey />
        <Volumes />
        <MicSection main={main} />
        <ScoreSection issue={main?.scoreIssue ?? null} />
      </div>
    </>
  )
}

/** One state per 大屏, in the words people use. */
function screenState(s: ScreenInfo): { text: string; tone: 'accent' | 'ok' | 'warn' | 'idle' } {
  if (s.main) return s.unlocked ? { text: '主屏', tone: 'accent' } : { text: '待点击', tone: 'warn' }
  if (s.muted) return { text: '静音', tone: 'idle' }
  // Unmuted, but nobody has clicked on that page yet: the browser keeps it silent.
  return s.unlocked ? { text: '发声', tone: 'ok' } : { text: '待点击', tone: 'warn' }
}

const toneDot = { accent: 'bg-accent', ok: 'bg-ok-dot', warn: 'bg-warn-dot', idle: 'bg-faint' }

function ScreenTabs({ screens, selected, onSelect }: { screens: ScreenInfo[]; selected: ScreenInfo | null; onSelect: (s: ScreenInfo) => void }) {
  return (
    <div role="tablist" aria-label="选择大屏" className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-0.5">
      {screens.map((s) => {
        const on = s.id === selected?.id
        const st = screenState(s)
        return (
          <button
            key={s.id}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => onSelect(s)}
            className={clsx(
              'flex min-w-[96px] shrink-0 flex-col items-start gap-1 rounded-2xl border px-3.5 py-2 text-left transition-colors',
              on ? 'border-fg bg-fg text-ink' : 'border-white/10 bg-white/[0.04] text-fg hover:bg-white/[0.08]',
            )}
          >
            <span className="flex items-center gap-1.5 text-sm font-bold whitespace-nowrap">
              <Icon name="tv" size={15} />
              大屏 {s.number}
            </span>
            <span className={clsx('flex items-center gap-1.5 text-xs whitespace-nowrap', on ? 'text-ink/70' : 'text-muted')}>
              <span className={clsx('h-1.5 w-1.5 rounded-full', toneDot[st.tone])} />
              {st.text}
            </span>
          </button>
        )
      })}
    </div>
  )
}

function NoScreen() {
  return (
    <div className="flex flex-col items-center gap-3 rounded-[20px] border border-dashed border-white/12 px-5 py-6 text-center">
      <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-white/6 text-muted">
        <Icon name="tv" size={22} />
      </span>
      <span className="text-sm leading-6 text-fg-2">
        还没有打开的大屏
        <br />
        <span className="text-muted">在电视或电脑浏览器打开大屏并点击开始</span>
      </span>
      <a
        href="/tv"
        target="_blank"
        rel="noreferrer"
        className="inline-flex h-10 items-center gap-2 rounded-xl bg-white/8 px-4 text-sm font-semibold hover:bg-white/12"
      >
        <Icon name="tv" size={16} />
        打开大屏
      </a>
    </div>
  )
}

// ---------------- the selected 大屏 ----------------

function ScreenCard({ screen }: { screen: ScreenInfo }) {
  const { data: settings } = useSettings()
  const unified = settings?.multiScreenSync ?? false
  const multiAudio = settings?.multiScreenAudio ?? false
  const singing = useApp((s) => !!s.state.player.current)
  const sharedMode = useApp((s) => s.state.player.displayMode ?? 'stage')
  const [armed, setArmed] = useState(false)
  useEffect(() => setArmed(false), [screen.id])
  useEffect(() => {
    if (!armed) return
    const t = window.setTimeout(() => setArmed(false), 3500)
    return () => window.clearTimeout(t)
  }, [armed])
  const [volume, setVolume] = useLive(Math.round(screen.volume * 100), (v) =>
    sendScreenCommand(screen.id, { action: 'set', volume: v / 100 }),
  )

  // The 主屏's mode is the shared one; with 多大屏协同 every 大屏 shows it too.
  const ownMode = !screen.main && !unified
  const mode: DisplayMode = ownMode ? screen.displayMode : sharedMode
  const setMode = (m: DisplayMode) => (ownMode ? sendScreenCommand(screen.id, { action: 'set', displayMode: m }) : set({ displayMode: m }))
  const promote = () => {
    if (singing && !armed) {
      setArmed(true)
      return
    }
    setArmed(false)
    sendScreenCommand(screen.id, { action: 'claim' })
  }

  let note: ReactNode
  if (screen.main) {
    note = screen.unlocked ? (
      '正在播放 · 声音从这块大屏输出'
    ) : (
      <span className="text-warn">等待有人在这块大屏上点一下“开始”（浏览器要求）</span>
    )
  } else {
    note = `跟随主屏播放${unified ? ' · 显示模式与主屏同步' : ''}`
  }

  return (
    <section aria-label={`大屏 ${screen.number}`} className="flex flex-col gap-4 rounded-[20px] border border-white/8 bg-white/[0.035] p-4">
      <div className="flex items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex items-center gap-2">
            <span className="text-[17px] font-bold">大屏 {screen.number}</span>
            <span
              className={clsx(
                'rounded-full px-2 py-0.5 text-[11px] font-semibold',
                screen.main ? 'bg-accent text-accent-ink' : 'bg-white/10 text-fg-2',
              )}
            >
              {screen.main ? '主屏' : '副屏'}
            </span>
          </span>
          <span className="text-xs leading-5 text-muted">{note}</span>
        </div>
        <button
          type="button"
          onClick={() => sendScreenCommand(screen.id, { action: 'identify' })}
          title="在这块大屏上显示它的编号"
          className="flex h-9 shrink-0 items-center gap-1.5 rounded-xl bg-white/6 px-3 text-[13px] text-fg-2 hover:bg-white/10 hover:text-fg"
        >
          <Icon name="compass" size={15} />
          定位
        </button>
      </div>

      <Row icon={mode === 'mv' ? 'video' : 'lyrics'} label="显示">
        <DisplayModeToggle size="sm" value={mode} onChange={setMode} />
      </Row>
      {!screen.main && unified && <span className="-mt-2 pl-[30px] text-[11px] text-faint">多大屏协同已开启：所有大屏一起切换</span>}

      {!screen.main &&
        (multiAudio ? (
          <div className="flex flex-col gap-2.5">
            <Row icon={screen.muted ? 'volumeOff' : 'volume'} label="发声">
              <Switch
                checked={!screen.muted}
                onChange={(v) => sendScreenCommand(screen.id, { action: 'set', muted: !v })}
                label={`大屏 ${screen.number} 发声`}
              />
            </Row>
            <SliderLine label={`大屏 ${screen.number} 音量`} value={volume} onChange={setVolume} disabled={screen.muted} />
            {!screen.muted && !screen.unlocked && (
              <span className="pl-[30px] text-[11px] text-warn">需要在这块大屏上点一下才能发声</span>
            )}
          </div>
        ) : (
          <span className="flex items-center gap-2 text-xs text-faint">
            <Icon name="volumeOff" size={15} />
            副屏不发声（可在设置里开启“多大屏播放”）
          </span>
        ))}

      {!screen.main && (
        <button
          type="button"
          onClick={promote}
          className={clsx(
            'flex h-11 items-center justify-center gap-2 rounded-2xl text-sm font-semibold transition-colors',
            armed ? 'bg-accent text-accent-ink' : 'border border-accent/45 text-accent-soft hover:bg-accent/12',
          )}
        >
          <Icon name="tv" size={17} />
          {armed ? `再按一次：声音转到大屏 ${screen.number}` : '设为主屏'}
        </button>
      )}
    </section>
  )
}

// ---------------- singing (on the 主屏) ----------------

function NowPlaying() {
  const player = useApp((s) => s.state.player)
  const now = useNow(500)
  const cur = player.current
  const dur = cur ? cur.song.duration / 1000 : 0
  const pos = cur ? Math.min(livePosition(player, now), dur || Infinity) : 0
  return (
    <section aria-label="正在演唱" className="flex flex-col gap-3.5">
      <div className="flex items-center gap-3">
        {cur ? (
          <Cover song={cur.song} px={120} className="h-12 w-12 rounded-[14px]" />
        ) : (
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-[14px] bg-white/6 text-faint">
            <Icon name="note" size={20} />
          </span>
        )}
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-[15px] font-semibold">{cur ? cur.song.name : '还没有在唱的歌'}</span>
          <span className="truncate text-xs text-muted">
            {cur ? `${artistsText(cur.song)}${cur.addedBy ? ` · ${cur.addedBy}` : ''}` : '点一首歌开始吧'}
          </span>
        </div>
      </div>
      {cur && (
        <div className="num flex items-center gap-2.5 text-[11px] text-muted">
          <span className="w-8">{fmtTime(pos)}</span>
          <ProgressBar value={dur ? pos / dur : 0} color="#FF4D7E" className="flex-1 bg-white/10" />
          <span className="w-8 text-right">{fmtTime(dur)}</span>
        </div>
      )}
      <div className="flex items-center justify-center gap-6">
        <RoundButton icon="replay" label="重唱" onClick={() => sendCommand({ action: 'restart' })} disabled={!cur} />
        <RoundButton
          icon={player.playing ? 'pause' : 'play'}
          label={player.playing ? '暂停' : '播放'}
          onClick={() => sendCommand({ action: 'toggle' })}
          disabled={!cur}
          primary
        />
        <RoundButton icon="next" label="切歌" onClick={() => sendCommand({ action: 'next' })} disabled={!cur} />
      </div>
    </section>
  )
}

function RoundButton({
  icon,
  label,
  onClick,
  disabled,
  primary,
}: {
  icon: IconName
  label: string
  onClick: () => void
  disabled?: boolean
  primary?: boolean
}) {
  return (
    <span className="flex flex-col items-center gap-1.5">
      <button
        type="button"
        aria-label={label}
        title={label}
        onClick={onClick}
        disabled={disabled}
        className={clsx(
          'flex items-center justify-center rounded-full transition-[transform,background-color] active:scale-95 disabled:opacity-35 disabled:active:scale-100',
          primary
            ? 'h-14 w-14 bg-accent text-accent-ink shadow-[0_10px_28px_rgba(255,77,126,0.4)] hover:brightness-110'
            : 'h-11 w-11 bg-white/8 text-fg hover:bg-white/14',
        )}
      >
        <Icon name={icon} size={primary ? 24 : 19} />
      </button>
      {!primary && <span className="text-[11px] text-muted">{label}</span>}
    </span>
  )
}

function ModesAndKey() {
  const cur = useApp((s) => s.state.player.current)
  const key = useApp((s) => s.state.player.key)
  const setKey = (k: number) => set({ key: Math.max(KEY_MIN, Math.min(KEY_MAX, k)) })
  return (
    <section aria-label="演唱模式与升降调" className="flex flex-col gap-3">
      {cur && (
        <Row icon="wave" label="演唱">
          <TrackModeToggle size="sm" />
        </Row>
      )}
      <Row icon="note" label="升降调">
        <div className="flex items-center gap-1.5">
          <StepButton icon="minus" label="降调" onClick={() => setKey(key - 1)} disabled={key <= KEY_MIN} />
          <span aria-live="polite" className="num w-9 text-center text-[17px] font-semibold text-accent">
            {key > 0 ? '+' + key : key}
          </span>
          <StepButton icon="plus" label="升调" onClick={() => setKey(key + 1)} disabled={key >= KEY_MAX} />
          <button
            type="button"
            onClick={() => setKey(0)}
            disabled={key === 0}
            className="ml-1 h-8 rounded-[10px] border border-white/12 px-2.5 text-xs text-fg-2 hover:bg-white/8 disabled:opacity-35"
          >
            原调
          </button>
        </div>
      </Row>
    </section>
  )
}

function Volumes() {
  const player = useApp((s) => s.state.player)
  const hasStems = useApp((s) => (player.current ? !!s.state.tracks[player.current.song.id]?.hasStems : false))
  const idleOn = useSettings().data?.idleEnabled ?? false
  const [music, setMusic] = useLive(Math.round(player.musicVolume * 100), (v) => set({ musicVolume: v / 100 }))
  const [idle, setIdle] = useLive(Math.round(player.idleVolume * 100), (v) => set({ idleVolume: v / 100 }))
  const karaoke = hasStems && player.trackMode === 'karaoke'
  return (
    <Section icon="volume" title="音量">
      <SliderLine label={karaoke ? '伴奏' : '歌曲'} value={music} onChange={setMusic} />
      {idleOn && <SliderLine label="待机音乐" value={idle} onChange={setIdle} color="#8B7BFF" />}
    </Section>
  )
}

const micErrorText: Record<MicErrorCode, string> = {
  insecure: '大屏需要通过 localhost 或 HTTPS 打开',
  denied: '大屏没有麦克风权限',
  unavailable: '设备被占用或已拔出',
}

function MicSection({ main }: { main: ScreenInfo | null }) {
  const player = useApp((s) => s.state.player)
  const [level, setLevel] = useLive(Math.round(player.micVolume * 100), (v) => set({ micVolume: v / 100 }))
  const [reverb, setReverb] = useLive(Math.round(player.reverb * 100), (v) => set({ reverb: v / 100 }))
  const [devicesOpen, setDevicesOpen] = useState(false)
  const mic = main?.mic ?? null
  const errors = mic ? Object.values(mic.errors) : []
  const status = !player.micOn
    ? '已关闭'
    : !main
      ? '大屏未打开'
      : !main.unlocked
        ? '主屏还没开始'
        : mic?.status === 'on'
          ? '已打开'
          : mic?.status === 'error'
            ? `没能打开：${micErrorText[errors[0] ?? 'unavailable']}`
            : '正在打开…'
  const trouble = player.micOn && mic?.status === 'error'
  const rows = mic ? [{ id: '', label: '系统默认' }, ...mic.devices.map((d, i) => ({ id: d.id, label: d.label || `麦克风 ${i + 1}` }))] : []
  const chosen = rows.filter((r) => mic?.selected.includes(r.id)).map((r) => r.label)

  return (
    <Section
      icon="mic"
      title="麦克风"
      status={<span className={clsx(trouble ? 'text-warn' : player.micOn && mic?.status === 'on' ? 'text-ok' : 'text-muted')}>{status}</span>}
      action={<Switch checked={player.micOn} onChange={(v) => set({ micOn: v })} label="麦克风开关" />}
    >
      <div className={clsx('flex flex-col gap-2.5 transition-opacity', !player.micOn && 'opacity-45')}>
        <SliderLine label="音量" value={level} onChange={setLevel} />
        <SliderLine label="混响" value={reverb} onChange={setReverb} color="#B57BFF" />
      </div>
      {mic && (
        <div className="flex flex-col rounded-2xl bg-white/[0.035]">
          <button
            type="button"
            onClick={() => setDevicesOpen((v) => !v)}
            aria-expanded={devicesOpen}
            className="flex h-11 items-center gap-2 px-3 text-left text-[13px]"
          >
            <span className="shrink-0 text-muted">输入设备</span>
            <span className="min-w-0 flex-1 truncate text-right text-fg-2">{chosen.join('、') || '系统默认'}</span>
            <Icon name="chevronLeft" size={15} className={clsx('shrink-0 text-muted transition-transform', devicesOpen ? 'rotate-90' : '-rotate-90')} />
          </button>
          {devicesOpen && (
            <div className="flex flex-col gap-0.5 px-1.5 pb-1.5">
              {rows.map((r) => {
                const on = mic.selected.includes(r.id)
                const err = player.micOn ? mic.errors[r.id] : undefined
                return (
                  <button
                    key={r.id || 'default'}
                    type="button"
                    role="checkbox"
                    aria-checked={on}
                    onClick={() => main && sendScreenCommand(main.id, { action: 'micDevice', deviceId: r.id })}
                    className="flex items-center gap-2.5 rounded-xl px-2 py-2 text-left hover:bg-white/5"
                  >
                    <span
                      className={clsx(
                        'flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[6px] border',
                        on ? 'border-accent bg-accent text-accent-ink' : 'border-white/25',
                      )}
                    >
                      {on && <Icon name="check" size={12} strokeWidth={2.8} />}
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-[13px]">{r.label}</span>
                      {err && <span className="text-[11px] text-warn">{micErrorText[err]}</span>}
                    </span>
                  </button>
                )
              })}
              {mic.devices.length > 0 && mic.devices.every((d) => !d.label) && (
                <span className="px-2 pt-1 text-[11px] text-faint">在大屏上允许麦克风权限后显示设备名称</span>
              )}
            </div>
          )}
        </div>
      )}
    </Section>
  )
}

function ScoreSection({ issue }: { issue: string | null }) {
  const on = useApp((s) => s.state.player.scoreOn)
  const allowed = useSettings().data?.scoringEnabled ?? true
  const hasPitch = useApp((s) => {
    const c = s.state.player.current
    return c ? !!s.state.tracks[c.song.id]?.hasPitch : true
  })
  const problem = on && allowed ? (issue ?? (hasPitch ? null : '这首歌暂无参考音高')) : null
  const status = !allowed ? '已在设置里关闭' : !on ? '已关闭' : problem ? `暂不可用：${problem}` : '已打开 · 主屏用麦克风打分'
  return (
    <Section
      icon="trophy"
      title="演唱评分"
      status={<span className={clsx(problem ? 'text-warn' : on && allowed ? 'text-ok' : 'text-muted')}>{status}</span>}
      action={<Switch checked={on && allowed} onChange={(v) => set({ scoreOn: v })} label="演唱评分开关" disabled={!allowed} />}
    />
  )
}

// ---------------- building blocks ----------------

function Section({
  icon,
  title,
  status,
  action,
  children,
}: {
  icon: IconName
  title: string
  status?: ReactNode
  action?: ReactNode
  children?: ReactNode
}) {
  return (
    <section aria-label={title} className="flex flex-col gap-3">
      <div className="flex items-center gap-2.5">
        <Icon name={icon} size={18} className="shrink-0 text-fg-2" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-sm font-semibold">{title}</span>
          {status && <span className="truncate text-xs">{status}</span>}
        </span>
        {action}
      </div>
      {children}
    </section>
  )
}

/** Label on the left, control on the right. */
function Row({ icon, label, children }: { icon: IconName; label: string; children: ReactNode }) {
  return (
    <div className="flex min-h-9 items-center gap-2.5">
      <Icon name={icon} size={18} className="shrink-0 text-fg-2" />
      <span className="flex-1 text-sm font-semibold">{label}</span>
      {children}
    </div>
  )
}

function SliderLine({
  label,
  value,
  onChange,
  color,
  disabled,
}: {
  label: string
  value: number
  onChange: (v: number) => void
  color?: string
  disabled?: boolean
}) {
  return (
    <div className={clsx('flex items-center gap-3 pl-[30px]', disabled && 'opacity-45')}>
      <span className="w-14 shrink-0 truncate text-[13px] text-fg-2">{label.replace(/^大屏 \d+ /, '')}</span>
      <div className="min-w-0 flex-1">
        <Range label={label} value={value} onChange={onChange} color={color} disabled={disabled} />
      </div>
      <span className="num w-9 shrink-0 text-right text-[13px] text-[#C8C8D0]">{value}%</span>
    </div>
  )
}

function StepButton({ icon, label, onClick, disabled }: { icon: IconName; label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className="flex h-8 w-8 items-center justify-center rounded-[10px] bg-white/8 hover:bg-white/14 disabled:opacity-35"
    >
      <Icon name={icon} size={15} strokeWidth={2.2} />
    </button>
  )
}
