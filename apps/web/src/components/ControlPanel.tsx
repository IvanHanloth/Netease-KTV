import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import type { DeskSettings, DisplayMode, MicErrorCode, PlayerCommand, ScreenInfo } from '@shared/types'
import { KEY_MAX, KEY_MIN } from '@shared/constants'
import { api, type SettingsResponse } from '../lib/api'
import { errorText, toast, useSettings } from '../lib/hooks'
import { DEFAULT_TOLERANCE, TOLERANCE_PRESETS } from '../player/scoring'
import { sendCommand, sendScreenCommand, useApp } from '../store/app'
import { Icon, type IconName } from './icons'
import { vocalModeCommand, type VocalMode } from './PlayerModes'

/**
 * 点歌台 控制台, laid out like a phone's control centre. The home page has a tile for everything you
 * reach for while singing (麦克风, 评分, the volumes, 伴唱/领唱/原唱, 升降调, 大屏); 麦克风, 评分 and
 * 大屏 open their own pages. Playback itself (重唱 / 播放 / 切歌, progress) lives in the 正在演唱 card.
 * Singing always happens on the 主屏.
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

/** Saves one 点歌台 setting at once (only the keys given), shown immediately, rolled back on failure. */
function useSaveSetting() {
  const qc = useQueryClient()
  return useCallback(
    async (patch: Partial<DeskSettings>) => {
      const prev = qc.getQueryData<SettingsResponse>(['settings'])
      if (prev) qc.setQueryData<SettingsResponse>(['settings'], { ...prev, ...patch })
      try {
        qc.setQueryData(['settings'], await api.saveSettings(patch))
      } catch (e) {
        if (prev) qc.setQueryData(['settings'], prev)
        toast(errorText(e), 'error')
      }
    },
    [qc],
  )
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

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
        className={clsx(
          'flex h-[52px] w-full items-center gap-3 rounded-2xl px-4 text-left transition-colors',
          open ? 'bg-white/12' : 'bg-white/[0.05] hover:bg-white/[0.08]',
        )}
      >
        <Icon name="sliders" size={19} className="shrink-0 text-fg-2" />
        <span className="flex-1 text-[15px] font-bold">控制台</span>
        <span className="shrink-0 text-[13px] text-muted">{main ? `大屏 ${main.number}` : screens.length ? `${screens.length} 块大屏` : '大屏未打开'}</span>
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
        setStyle({ right, bottom: vh - r.top + gap, maxHeight: Math.min(820, above) })
      } else {
        // Not enough room above the button: to its left, bottom-aligned with it.
        setStyle({ right: Math.max(16, vw - r.left + gap), bottom: Math.max(16, vh - r.bottom), maxHeight: Math.min(820, vh - 32) })
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
          className="fixed inset-0 z-40 bg-black/50"
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
          'fixed z-50 flex flex-col overflow-hidden rounded-[26px] bg-[#16161E] text-fg shadow-[0_30px_80px_rgba(0,0,0,0.6)] outline-none',
          !sheet && 'w-[440px]',
        )}
      >
        {children}
      </motion.div>
    </>
  )
}

// ---------------- the panel ----------------

type View = 'home' | 'mic' | 'score' | 'screens'
const viewTitle: Record<View, string> = { home: '控制台', mic: '麦克风', score: '评分', screens: '大屏' }

/** A home page of tiles; 麦克风, 评分 and 大屏 each open their own page. */
function ControlPanel({ onClose }: { onClose: () => void }) {
  const [view, setViewState] = useState<View>('home')
  const titleRef = useRef<HTMLHeadingElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  // Pages keep the home page's height, so the panel doesn't jump while moving between them.
  const [minHeight, setMinHeight] = useState<number | undefined>(undefined)
  const setView = (v: View) => {
    if (view === 'home' && bodyRef.current) setMinHeight(bodyRef.current.offsetHeight)
    setViewState(v)
  }
  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    titleRef.current?.focus({ preventScroll: true })
  }, [view])

  return (
    <>
      <header className="flex items-center gap-1.5 pt-[18px] pr-3.5 pb-2 pl-[22px]">
        {view !== 'home' && (
          <button
            type="button"
            onClick={() => setView('home')}
            aria-label="返回控制台"
            className="-ml-2.5 flex h-9 w-9 items-center justify-center rounded-[10px] text-fg-2 hover:bg-white/8 hover:text-fg"
          >
            <Icon name="chevronLeft" size={19} strokeWidth={2.2} />
          </button>
        )}
        <h2 ref={titleRef} tabIndex={-1} className="m-0 flex-1 text-lg font-extrabold outline-none">
          {viewTitle[view]}
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭控制台"
          className="flex h-9 w-9 items-center justify-center rounded-[10px] text-faint hover:bg-white/8 hover:text-fg"
        >
          <Icon name="x" size={17} />
        </button>
      </header>
      <div
        ref={bodyRef}
        style={view === 'home' ? undefined : { minHeight }}
        className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain px-[22px] pt-2 pb-[22px]"
      >
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={view}
            initial={{ opacity: 0, x: view === 'home' ? -14 : 14 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.16, ease: 'easeOut' }}
          >
            {view === 'home' ? <Home open={setView} /> : view === 'mic' ? <MicPage /> : view === 'score' ? <ScorePage /> : <ScreensPage />}
          </motion.div>
        </AnimatePresence>
      </div>
    </>
  )
}

/** One state per 大屏, in the words people use. */
function screenState(s: ScreenInfo): { text: string; tone: 'accent' | 'warn' | 'idle' } {
  if (s.main) return s.unlocked ? { text: '正在发声', tone: 'accent' } : { text: '待点击', tone: 'warn' }
  if (s.muted) return { text: '静音', tone: 'idle' }
  // Unmuted, but nobody has clicked on that page yet: the browser keeps it silent.
  return s.unlocked ? { text: '发声', tone: 'idle' } : { text: '待点击', tone: 'warn' }
}

const micErrorText: Record<MicErrorCode, string> = {
  insecure: '大屏需要通过 localhost 或 HTTPS 打开',
  denied: '大屏没有麦克风权限',
  unavailable: '设备被其他程序占用或已拔出',
}

/** Why the 主屏 microphone isn't working right now (null: it is, or it's off). */
function useMicProblem(): string | null {
  const micOn = useApp((s) => s.state.player.micOn)
  const main = useApp((s) => s.screens.find((x) => x.main) ?? null)
  if (!micOn) return null
  if (!main) return '大屏未打开'
  if (!main.unlocked) return '主屏待点击'
  if (main.mic?.status === 'error') return micErrorText[Object.values(main.mic.errors)[0] ?? 'unavailable']
  return null
}

/** 评分: the live toggle, the saved 容错, and why it isn't scoring right now. */
function useScore() {
  const on = useApp((s) => s.state.player.scoreOn)
  const issue = useApp((s) => s.screens.find((x) => x.main)?.scoreIssue ?? null)
  const hasPitch = useApp((s) => {
    const c = s.state.player.current
    return c ? !!s.state.tracks[c.song.id]?.hasPitch : true
  })
  const settings = useSettings().data
  const save = useSaveSetting()
  const allowed = settings?.scoringEnabled ?? true
  const active = on && allowed
  const tolerance = Math.round((settings?.scoreTolerance ?? DEFAULT_TOLERANCE) * 10) / 10
  const preset = TOLERANCE_PRESETS.find((p) => Math.abs(p.value - tolerance) < 0.05)
  return {
    active,
    problem: active ? (issue ?? (hasPitch ? null : '本曲不支持')) : null,
    tolerance,
    preset,
    // Turning it on also lifts the 点歌台 setting that used to switch scoring off for everyone.
    toggle: (v: boolean) => {
      if (v && !allowed) void save({ scoringEnabled: true })
      set({ scoreOn: v })
    },
    setTolerance: (value: number) => void save({ scoreTolerance: value }),
  }
}

// ---------------- home ----------------

function Home({ open }: { open: (v: View) => void }) {
  const player = useApp((s) => s.state.player)
  const main = useApp((s) => s.screens.find((x) => x.main) ?? null)
  const screenCount = useApp((s) => s.screens.length)
  const hasStems = useApp((s) => (player.current ? !!s.state.tracks[player.current.song.id]?.hasStems : false))
  const idleOn = useSettings().data?.idleEnabled ?? false
  const micProblem = useMicProblem()
  const score = useScore()
  const [music, setMusic] = useLive(Math.round(player.musicVolume * 100), (v) => set({ musicVolume: v / 100 }))
  const [mic, setMic] = useLive(Math.round(player.micVolume * 100), (v) => set({ micVolume: v / 100 }))
  const [reverb, setReverb] = useLive(Math.round(player.reverb * 100), (v) => set({ reverb: v / 100 }))
  const [idle, setIdle] = useLive(Math.round(player.idleVolume * 100), (v) => set({ idleVolume: v / 100 }))
  const karaoke = hasStems && player.trackMode === 'karaoke'
  const inputs = main?.mic?.selected.length ?? 0
  const sharedMode = player.displayMode ?? 'stage'

  return (
    <div className="grid grid-cols-4 gap-2.5">
      <FeatureTile
        icon="mic"
        title="麦克风"
        on={player.micOn}
        sub={micProblem ?? (player.micOn ? (inputs ? `${inputs} 个输入` : '已开') : '已关')}
        warn={!!micProblem}
        toggleLabel="麦克风开关"
        onToggle={(v) => set({ micOn: v })}
        onOpen={() => open('mic')}
      />
      <FeatureTile
        icon="trophy"
        title="评分"
        on={score.active}
        sub={score.problem ?? (score.active ? `${score.preset?.label ?? '自定义'}容错` : '已关')}
        warn={!!score.problem}
        toggleLabel="评分开关"
        onToggle={score.toggle}
        onOpen={() => open('score')}
      />
      <FillSlider vertical label={karaoke ? '伴奏' : '歌曲'} icon="note" value={music} onChange={setMusic} />
      <FillSlider vertical label="麦克风" icon="mic" value={mic} onChange={setMic} disabled={!player.micOn} />
      <FillSlider vertical label="混响" icon="sparkles" value={reverb} onChange={setReverb} disabled={!player.micOn} />
      <FillSlider vertical label="待机音乐" icon="clock" value={idle} onChange={setIdle} disabled={!idleOn} />
      <ModeTile />
      <KeyTile />
      <button
        type="button"
        onClick={() => open('screens')}
        aria-label={`大屏设置，共 ${screenCount} 块`}
        className="col-span-2 flex h-[100px] flex-col justify-between rounded-[22px] bg-white/7 p-3.5 text-left transition-colors hover:bg-white/10"
      >
        <span className="flex w-full items-start justify-between">
          <Icon name="tv" size={22} className="text-fg-2" />
          <span className="flex items-center gap-0.5 text-xs text-muted">
            {screenCount ? `共 ${screenCount} 块` : '未打开'}
            <Icon name="chevronLeft" size={14} strokeWidth={2} className="rotate-180" />
          </span>
        </span>
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-[15px] font-bold">{main ? `大屏 ${main.number}` : '大屏'}</span>
          <span className={clsx('truncate text-xs', main && !main.unlocked ? 'text-warn' : 'text-muted')}>
            {!main ? '还没有打开的大屏' : !main.unlocked ? '主屏待点击' : sharedMode === 'mv' ? 'MV 模式' : '舞台模式'}
          </span>
        </span>
      </button>
    </div>
  )
}

/**
 * A feature with an on/off state and its own page: the round icon switches it, the rest opens the
 * page. Red while on, grey while off.
 */
function FeatureTile({
  icon,
  title,
  sub,
  on,
  warn,
  toggleLabel,
  onToggle,
  onOpen,
}: {
  icon: IconName
  title: string
  sub: string
  on: boolean
  warn?: boolean
  toggleLabel: string
  onToggle: (v: boolean) => void
  onOpen: () => void
}) {
  return (
    <div className={clsx('relative col-span-2 h-[112px] rounded-[22px] transition-colors', on ? 'bg-accent/16' : 'bg-white/7')}>
      <button
        type="button"
        onClick={onOpen}
        aria-label={`${title}设置：${sub}`}
        className="absolute inset-0 flex flex-col justify-end rounded-[22px] p-3.5 text-left transition-colors hover:bg-white/4"
      >
        <span className={clsx('text-[15px] font-bold', on && 'text-[#FFD1DD]')}>{title}</span>
        <span className={clsx('truncate text-xs', warn ? 'text-warn' : on ? 'text-accent-soft' : 'text-muted')}>{sub}</span>
      </button>
      <Icon
        name="chevronLeft"
        size={16}
        strokeWidth={2}
        aria-hidden="true"
        className={clsx('pointer-events-none absolute top-3.5 right-3.5 rotate-180', on ? 'text-accent-soft' : 'text-muted')}
      />
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={toggleLabel}
        onClick={() => onToggle(!on)}
        className={clsx(
          'absolute top-3.5 left-3.5 flex h-10 w-10 items-center justify-center rounded-full transition-[background-color,transform] active:scale-95',
          on ? 'bg-accent text-accent-ink' : 'bg-white/12 text-fg-2 hover:bg-white/18',
        )}
      >
        <Icon name={icon} size={19} strokeWidth={on ? 2 : 1.8} />
      </button>
    </div>
  )
}

const vocalModes: readonly (readonly [VocalMode, string, IconName])[] = [
  ['karaoke', '伴唱', 'wave'],
  ['lead', '领唱', 'note'],
  ['original', '原唱', 'mic'],
]

function ModeTile() {
  const player = useApp((s) => s.state.player)
  const track = useApp((s) => (player.current ? s.state.tracks[player.current.song.id] : undefined))
  const onlyOriginal = !!player.current && track?.status === 'ready' && !track.hasStems
  const value: VocalMode = player.trackMode === 'original' ? 'original' : player.leadVocal ? 'lead' : 'karaoke'
  if (onlyOriginal) {
    return (
      <div
        className="col-span-4 flex h-16 items-center justify-center gap-2 rounded-[22px] bg-white/4 text-sm text-subtle"
        title="这首歌没有分离出伴奏，只能播放原曲"
      >
        <Icon name="note" size={17} />
        仅原曲
      </div>
    )
  }
  const disabled = !player.current
  return (
    <div role="group" aria-label="伴唱、领唱或原唱" className="col-span-4 grid grid-cols-3 gap-1 rounded-[22px] bg-white/7 p-1">
      {vocalModes.map(([v, text, icon]) => {
        const on = !disabled && v === value
        return (
          <button
            key={v}
            type="button"
            aria-pressed={on}
            disabled={disabled}
            onClick={() => !on && sendCommand({ action: 'set', ...vocalModeCommand(v) })}
            className={clsx(
              'flex h-14 items-center justify-center gap-2 rounded-[18px] text-sm transition-colors',
              on ? 'bg-fg font-bold text-ink' : 'font-semibold text-fg-2 hover:bg-white/6 hover:text-fg',
              'disabled:cursor-not-allowed disabled:text-faint disabled:hover:bg-transparent',
            )}
          >
            <Icon name={icon} size={18} />
            {text}
          </button>
        )
      })}
    </div>
  )
}

function KeyTile() {
  const key = useApp((s) => s.state.player.key)
  const setKey = (k: number) => set({ key: Math.max(KEY_MIN, Math.min(KEY_MAX, k)) })
  return (
    <div className="col-span-2 flex h-[100px] flex-col justify-between rounded-[22px] bg-white/7 pt-3 pr-2.5 pb-2.5 pl-3.5">
      <span className="flex items-baseline justify-between">
        <span className="text-[13px] text-muted">升降调</span>
        <button
          type="button"
          onClick={() => setKey(0)}
          disabled={key === 0}
          aria-live="polite"
          aria-label={key === 0 ? '原调' : `当前 ${key > 0 ? '+' + key : key}，点击回到原调`}
          title={key === 0 ? '原调' : '回到原调'}
          className={clsx('num mr-1 rounded-md px-1 text-[13px] font-bold', key === 0 ? 'text-fg-2' : 'text-accent-soft hover:bg-white/8')}
        >
          {key === 0 ? '原调' : key > 0 ? '+' + key : key}
        </button>
      </span>
      <span role="group" aria-label="升降调" className="flex gap-1.5">
        <button
          type="button"
          aria-label="降调"
          onClick={() => setKey(key - 1)}
          disabled={key <= KEY_MIN}
          className="flex h-11 flex-1 items-center justify-center rounded-[14px] bg-white/8 text-fg hover:bg-white/14 disabled:cursor-not-allowed disabled:text-faint disabled:hover:bg-white/8"
        >
          <Icon name="minus" size={18} strokeWidth={2.2} />
        </button>
        <button
          type="button"
          aria-label="升调"
          onClick={() => setKey(key + 1)}
          disabled={key >= KEY_MAX}
          className="flex h-11 flex-1 items-center justify-center rounded-[14px] bg-white/8 text-fg hover:bg-white/14 disabled:cursor-not-allowed disabled:text-faint disabled:hover:bg-white/8"
        >
          <Icon name="plus" size={18} strokeWidth={2.2} />
        </button>
      </span>
    </div>
  )
}

// ---------------- 麦克风 ----------------

function MicPage() {
  const player = useApp((s) => s.state.player)
  const main = useApp((s) => s.screens.find((x) => x.main) ?? null)
  const problem = useMicProblem()
  const [level, setLevel] = useLive(Math.round(player.micVolume * 100), (v) => set({ micVolume: v / 100 }))
  const [reverb, setReverb] = useLive(Math.round(player.reverb * 100), (v) => set({ reverb: v / 100 }))
  const mic = main?.mic ?? null
  const rows = mic ? [{ id: '', label: '系统默认' }, ...mic.devices.map((d, i) => ({ id: d.id, label: d.label || `麦克风 ${i + 1}` }))] : []

  return (
    <div className="flex flex-col gap-3.5">
      <SwitchTile
        icon="mic"
        title="麦克风"
        sub={problem ?? (main ? `从 大屏 ${main.number} 播放` : '大屏未打开')}
        warn={!!problem}
        on={player.micOn}
        onChange={(v) => set({ micOn: v })}
      />
      <div className="grid grid-cols-2 gap-2.5">
        <FillSlider label="音量" value={level} onChange={setLevel} disabled={!player.micOn} className="h-16 rounded-[20px]" />
        <FillSlider label="混响" value={reverb} onChange={setReverb} disabled={!player.micOn} className="h-16 rounded-[20px]" />
      </div>
      <section aria-label="输入设备" className="flex flex-col gap-2">
        <span className="text-sm font-bold">输入设备</span>
        {mic ? (
          <div className="flex flex-col overflow-hidden rounded-[18px] bg-white/[0.04]">
            {rows.map((r) => {
              const on = mic.selected.includes(r.id)
              const err = player.micOn ? mic.errors[r.id] : undefined
              const note = err ? micErrorText[err] : on && player.micOn && mic.status === 'on' ? '正在收音' : null
              return (
                <button
                  key={r.id || 'default'}
                  type="button"
                  role="checkbox"
                  aria-checked={on}
                  onClick={() => sendScreenCommand(main!.id, { action: 'micDevice', deviceId: r.id })}
                  className="flex items-center gap-3 border-b border-white/6 px-3.5 py-3 text-left last:border-b-0 hover:bg-white/4"
                >
                  <span
                    className={clsx(
                      'flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-[7px]',
                      on ? 'bg-accent text-accent-ink' : 'border-[1.5px] border-white/30',
                    )}
                  >
                    {on && <Icon name="check" size={14} strokeWidth={3} />}
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className={clsx('truncate text-sm font-semibold', !on && 'text-fg-2')}>{r.label}</span>
                    {note && <span className={clsx('text-[11px]', err ? 'text-accent-soft' : 'text-muted')}>{note}</span>}
                  </span>
                  {!on && <span className="shrink-0 text-xs text-subtle">未用</span>}
                </button>
              )
            })}
          </div>
        ) : (
          <p className="m-0 rounded-[18px] bg-white/[0.04] px-3.5 py-3 text-[13px] text-muted">主屏打开后，可以在这里选输入设备。</p>
        )}
      </section>
      <p className="m-0 flex gap-2 rounded-[14px] bg-white/[0.04] px-3.5 py-3 text-xs leading-relaxed text-muted">
        <Icon name="info" size={16} className="mt-px shrink-0" />
        麦克风的声音默认从主屏播放
      </p>
    </div>
  )
}

// ---------------- 评分 ----------------

/** The band each 容错 allows around the pitch line, drawn on its card. */
const toleranceArt: Record<string, { band: number; wave: string }> = {
  宽松: { band: 18, wave: 'M4 18c8-8 14 4 22-3s14 6 26-4' },
  标准: { band: 12, wave: 'M4 16c8-4 14 2 22-1.5s14 3 26-2' },
  严格: { band: 6, wave: 'M4 15.5c8-1.5 14 1 22-.5s14 1 26-.5' },
}
const toleranceHint: Record<string, string> = { 宽松: '朋友聚会', 标准: '大多数人', 严格: '想挑战高分' }

function ScorePage() {
  const score = useScore()
  return (
    <div className="flex flex-col gap-3.5">
      <SwitchTile
        icon="trophy"
        title="评分"
        sub={score.problem ?? '显示音准线打分，参与排行榜排名'}
        warn={!!score.problem}
        on={score.active}
        onChange={score.toggle}
      />
      <section aria-label="容错" className="flex flex-col gap-2">
        <span className="flex items-baseline justify-between">
          <span className="text-sm font-bold">容错</span>
          {!score.preset && <span className="num text-xs text-muted">当前 ±{score.tolerance.toFixed(1)} 个半音</span>}
        </span>
        <div role="radiogroup" aria-label="容错" className="grid grid-cols-3 gap-2">
          {TOLERANCE_PRESETS.map((p) => {
            const on = score.preset?.value === p.value
            const art = toleranceArt[p.label]!
            return (
              <button
                key={p.label}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => !on && score.setTolerance(p.value)}
                className={clsx(
                  'flex h-[150px] flex-col items-start justify-between rounded-[20px] border px-3 py-3.5 text-left transition-colors',
                  on ? 'border-accent/50 bg-accent/14' : 'border-transparent bg-white/6 hover:bg-white/9',
                )}
              >
                <svg aria-hidden="true" width="56" height="30" viewBox="0 0 56 30" fill="none">
                  <rect x="0" y={15 - art.band / 2} width="56" height={art.band} rx={art.band / 2} fill={on ? 'rgba(255,77,126,.3)' : 'rgba(255,255,255,.12)'} />
                  <path d={art.wave} stroke={on ? '#FF8FAB' : '#D4D4DC'} strokeWidth="2" strokeLinecap="round" />
                </svg>
                <span className="flex flex-col gap-[3px]">
                  <span className={clsx('text-[15px] font-bold', on && 'text-[#FFD1DD]')}>{p.label}</span>
                  <span className={clsx('text-[11px] leading-normal', on ? 'text-accent-soft' : 'text-muted')}>
                    差 <span className="num">{p.value}</span> 个半音
                    <br />
                    {toleranceHint[p.label]}
                  </span>
                </span>
              </button>
            )
          })}
        </div>
      </section>
      <section aria-label="如何使用" className="flex flex-col gap-2.5 rounded-[18px] bg-white/[0.04] px-4 py-3.5">
        <span className="text-[13px] font-bold">如何使用</span>
        {['输入音准与歌曲音准匹配即可得分。', '评分功能需要首先打开麦克风功能。', '部分歌曲可能没有音准数据，无法进行评分。'].map((t, i) => (
          <span key={i} className="flex gap-2.5 text-xs leading-relaxed text-muted">
            <span className="num flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-white/8 text-[11px] font-bold text-fg-2">{i + 1}</span>
            {t}
          </span>
        ))}
      </section>
    </div>
  )
}

// ---------------- 大屏 ----------------

function ScreensPage() {
  const screens = useApp((s) => s.screens)
  const settings = useSettings().data
  const save = useSaveSetting()
  const unified = settings?.multiScreenSync ?? false
  const multiAudio = settings?.multiScreenAudio ?? false
  const main = screens.find((s) => s.main) ?? null
  const others = screens.filter((s) => !s.main)

  return (
    <div className="flex flex-col gap-3">
      {main ? (
        <MainScreenCard screen={main} />
      ) : (
        <div className="flex items-center gap-3 rounded-[22px] bg-white/7 p-3.5">
          <span className="flex-1 text-sm text-muted">{screens.length ? '还没有主屏' : '还没有打开的大屏'}</span>
          <a
            href="/tv"
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-white/8 px-3 text-[13px] font-semibold text-fg hover:bg-white/12"
          >
            <Icon name="tv" size={15} />
            打开大屏
          </a>
        </div>
      )}
      {screens.length > 0 && <SecondaryScreens screens={others} unified={unified} multiAudio={multiAudio} />}
      <div className="grid grid-cols-2 gap-2.5">
        <SmallSwitchTile icon="screens" title="统一画面" on={unified} onChange={(v) => void save({ multiScreenSync: v })} hint="所有大屏用同一种显示模式" />
        <SmallSwitchTile icon="volume" title="副屏发声" on={multiAudio} onChange={(v) => void save({ multiScreenAudio: v })} hint="副屏可以和主屏一起发声" />
      </div>
    </div>
  )
}

/** The 主屏 comes first and gets every control; its volume is the music volume. */
function MainScreenCard({ screen }: { screen: ScreenInfo }) {
  const sharedMode = useApp((s) => s.state.player.displayMode ?? 'stage')
  const musicVolume = useApp((s) => s.state.player.musicVolume)
  const [volume, setVolume] = useLive(Math.round(musicVolume * 100), (v) => set({ musicVolume: v / 100 }))
  const st = screenState(screen)
  return (
    <section aria-label={`大屏 ${screen.number}（主屏）`} className="flex flex-col gap-2.5 rounded-[22px] border border-accent/35 bg-accent/12 p-3.5">
      <div className="flex items-center gap-3">
        <span className="num flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent text-lg font-bold text-accent-ink">{screen.number}</span>
        <span className="flex min-w-0 flex-1 flex-col gap-px">
          <span className="flex items-center gap-1.5">
            <span className="text-[15px] font-bold text-[#FFD1DD]">大屏 {screen.number}</span>
            <span className="flex h-[18px] items-center rounded-md bg-accent px-1.5 text-[11px] font-bold text-accent-ink">主屏</span>
          </span>
          <span className={clsx('truncate text-xs', st.tone === 'warn' ? 'text-warn' : 'text-accent-soft')}>{st.text}</span>
        </span>
        <LocateButton screen={screen} tone="accent" />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <ModeSwitch label={`大屏 ${screen.number} 显示模式`} value={sharedMode} onChange={(m) => set({ displayMode: m })} tone="accent" />
        <FillSlider label="主屏音量" icon="volume" value={volume} onChange={setVolume} className="h-[46px] rounded-[15px]" track="bg-black/25" />
      </div>
    </section>
  )
}

/**
 * Every 副屏 shares one set of controls: pick which one along the top (it scrolls sideways when
 * there are many), and the controls below act on it.
 */
function SecondaryScreens({ screens, unified, multiAudio }: { screens: ScreenInfo[]; unified: boolean; multiAudio: boolean }) {
  const [focusId, setFocusId] = useState<number | null>(null)
  const focused = screens.find((s) => s.id === focusId) ?? screens[0] ?? null
  const addScreen = () => {
    const url = `${location.origin}/tv`
    const fallback = () => window.open('/tv', '_blank', 'noopener')
    if (!navigator.clipboard) return fallback()
    navigator.clipboard.writeText(url).then(
      () => toast('大屏链接已复制，在电视或电脑浏览器里打开'),
      fallback,
    )
  }

  return (
    <section aria-label="副屏" className="flex flex-col gap-2.5 rounded-[22px] bg-white/7 p-3.5">
      <div className="flex items-center gap-2">
        <span className="text-sm font-bold">副屏</span>
        {screens.length > 0 && <span className="num text-xs text-muted">共 {screens.length} 块</span>}
        <span className="flex-1" />
        <button
          type="button"
          onClick={addScreen}
          aria-label="再加一块大屏：复制大屏链接"
          title="复制大屏链接"
          className="flex h-7 items-center gap-1 rounded-[9px] bg-white/8 px-2.5 text-xs text-fg-2 hover:bg-white/12 hover:text-fg"
        >
          <Icon name="plus" size={13} strokeWidth={2.4} />
          添加
        </button>
      </div>
      {!focused ? (
        <p className="m-0 text-[13px] leading-relaxed text-muted">只有一块大屏。在别的电视或电脑浏览器里打开大屏链接，就能多屏一起唱。</p>
      ) : (
        <>
          <div
            role="tablist"
            aria-label="选择要控制的副屏"
            className="-mx-3.5 flex gap-1.5 overflow-x-auto px-3.5"
            style={screens.length > 5 ? { scrollbarWidth: 'none', maskImage: 'linear-gradient(90deg, #000 85%, transparent)' } : { scrollbarWidth: 'none' }}
          >
            {screens.map((s) => {
              const on = s.id === focused.id
              const st = screenState(s)
              const loud = st.text === '发声'
              return (
                <button
                  key={s.id}
                  type="button"
                  role="tab"
                  aria-selected={on}
                  aria-label={`大屏 ${s.number}（${st.text}）`}
                  onClick={() => setFocusId(s.id)}
                  className={clsx(
                    'flex h-[52px] w-16 shrink-0 flex-col items-center justify-center gap-0.5 rounded-[14px] transition-colors',
                    on ? 'bg-fg text-ink' : 'bg-black/25 text-fg-2 hover:bg-black/40',
                  )}
                >
                  <span className="num text-[17px] font-bold">{s.number}</span>
                  <span
                    className={clsx(
                      'flex items-center gap-[3px] text-[10px]',
                      on ? 'text-[#3F3F46]' : st.tone === 'warn' ? 'text-warn' : loud ? 'text-muted' : 'text-subtle',
                    )}
                  >
                    <span
                      className={clsx(
                        'h-[5px] w-[5px] rounded-full',
                        st.tone === 'warn' ? 'bg-warn-dot' : loud ? (on ? 'bg-[#16A34A]' : 'bg-ok') : 'bg-[#5A5A66]',
                      )}
                    />
                    {st.text}
                  </span>
                </button>
              )
            })}
          </div>
          <div className="h-px bg-white/6" />
          <ScreenControls key={focused.id} screen={focused} unified={unified} multiAudio={multiAudio} />
        </>
      )}
    </section>
  )
}

function ScreenControls({ screen, unified, multiAudio }: { screen: ScreenInfo; unified: boolean; multiAudio: boolean }) {
  const singing = useApp((s) => !!s.state.player.current)
  const sharedMode = useApp((s) => s.state.player.displayMode ?? 'stage')
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!armed) return
    const t = window.setTimeout(() => setArmed(false), 3500)
    return () => window.clearTimeout(t)
  }, [armed])
  const [volume, setVolume] = useLive(Math.round(screen.volume * 100), (v) => sendScreenCommand(screen.id, { action: 'set', volume: v / 100 }))
  const st = screenState(screen)
  const mode: DisplayMode = unified ? sharedMode : screen.displayMode
  const promote = () => {
    if (singing && !armed) return setArmed(true)
    setArmed(false)
    sendScreenCommand(screen.id, { action: 'claim' })
  }
  const status = !multiAudio ? '静音 · 副屏发声已关' : unified ? `${st.text} · 画面跟随主屏` : st.text

  return (
    <div role="tabpanel" aria-label={`大屏 ${screen.number} 的控制`} className="flex flex-col gap-2.5">
      <div className="flex items-center gap-2">
        <span className="flex min-w-0 flex-1 flex-col gap-px">
          <span className="text-sm font-bold">大屏 {screen.number}</span>
          <span className={clsx('truncate text-[11px]', st.tone === 'warn' && multiAudio ? 'text-warn' : 'text-muted')}>{status}</span>
        </span>
        <LocateButton screen={screen} />
        <button
          type="button"
          onClick={promote}
          className={clsx(
            'h-8 shrink-0 rounded-[11px] px-2.5 text-xs transition-colors',
            armed ? 'bg-accent font-bold text-accent-ink' : 'bg-white/8 text-fg-2 hover:bg-white/12 hover:text-fg',
          )}
        >
          {armed ? '再按一次确认' : '设为主屏'}
        </button>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <ModeSwitch
          label={`大屏 ${screen.number} 显示模式`}
          value={mode}
          disabled={unified}
          onChange={(m) => sendScreenCommand(screen.id, { action: 'set', displayMode: m })}
        />
        <div className="flex gap-1.5">
          <button
            type="button"
            role="switch"
            aria-checked={multiAudio && !screen.muted}
            aria-label={`大屏 ${screen.number} 发声`}
            title={screen.muted ? '取消静音' : '静音'}
            disabled={!multiAudio}
            onClick={() => sendScreenCommand(screen.id, { action: 'set', muted: !screen.muted })}
            className="flex h-[46px] w-10 shrink-0 items-center justify-center rounded-[15px] bg-black/25 text-fg-2 hover:text-fg disabled:cursor-not-allowed disabled:text-faint"
          >
            <Icon name={!multiAudio || screen.muted ? 'volumeOff' : 'volume'} size={17} />
          </button>
          <FillSlider
            label={`大屏 ${screen.number} 音量`}
            text="音量"
            value={volume}
            onChange={setVolume}
            disabled={!multiAudio || screen.muted}
            className="h-[46px] min-w-0 flex-1 rounded-[15px]"
            track="bg-black/25"
          />
        </div>
      </div>
    </div>
  )
}

function LocateButton({ screen, tone }: { screen: ScreenInfo; tone?: 'accent' }) {
  return (
    <button
      type="button"
      aria-label={`定位大屏 ${screen.number}`}
      title="在这块大屏上显示编号"
      onClick={() => sendScreenCommand(screen.id, { action: 'identify' })}
      className={clsx(
        'flex h-8 shrink-0 items-center gap-1 rounded-[11px] px-2.5 text-xs transition-colors',
        tone === 'accent' ? 'bg-black/25 text-[#FFD1DD] hover:bg-black/40' : 'bg-white/8 text-fg-2 hover:bg-white/12 hover:text-fg',
      )}
    >
      <Icon name="locate" size={13} strokeWidth={2} />
      定位
    </button>
  )
}

function ModeSwitch({
  label,
  value,
  onChange,
  disabled,
  tone,
}: {
  label: string
  value: DisplayMode
  onChange: (m: DisplayMode) => void
  disabled?: boolean
  tone?: 'accent'
}) {
  return (
    <div role="group" aria-label={label} className="grid grid-cols-2 gap-[3px] rounded-[15px] bg-black/25 p-[3px]">
      {(
        [
          ['stage', '舞台'],
          ['mv', 'MV'],
        ] as const
      ).map(([m, text]) => {
        const on = m === value
        return (
          <button
            key={m}
            type="button"
            aria-pressed={on}
            disabled={disabled}
            onClick={() => !on && onChange(m)}
            className={clsx(
              'h-10 rounded-xl text-[13px] transition-colors disabled:cursor-not-allowed',
              on
                ? disabled
                  ? 'bg-white/14 font-bold text-muted'
                  : 'bg-fg font-bold text-ink'
                : disabled
                  ? 'font-semibold text-faint'
                  : clsx('font-semibold hover:bg-white/6', tone === 'accent' ? 'text-[#FFD1DD]' : 'text-fg-2'),
            )}
          >
            {text}
          </button>
        )
      })}
    </div>
  )
}

// ---------------- building blocks ----------------

/** A wide on/off tile at the top of a page: red while on, grey while off. */
function SwitchTile({
  icon,
  title,
  sub,
  warn,
  on,
  onChange,
}: {
  icon: IconName
  title: string
  sub: string
  warn?: boolean
  on: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={`${title}开关`}
      onClick={() => onChange(!on)}
      className={clsx('flex items-center gap-3.5 rounded-[22px] p-3.5 text-left transition-colors', on ? 'bg-accent/16 hover:bg-accent/20' : 'bg-white/7 hover:bg-white/10')}
    >
      <span className={clsx('flex h-12 w-12 shrink-0 items-center justify-center rounded-full transition-colors', on ? 'bg-accent text-accent-ink' : 'bg-white/12 text-fg-2')}>
        <Icon name={icon} size={22} strokeWidth={on ? 2 : 1.8} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className={clsx('text-base font-bold', on && 'text-[#FFD1DD]')}>{title}</span>
        <span className={clsx('text-xs', warn ? 'text-warn' : on ? 'text-accent-soft' : 'text-muted')}>{sub}</span>
      </span>
      <span aria-hidden="true" className={clsx('relative h-[26px] w-11 shrink-0 rounded-full transition-colors', on ? 'bg-accent' : 'bg-white/16')}>
        <span className={clsx('absolute top-[3px] h-5 w-5 rounded-full bg-white transition-[left]', on ? 'left-[21px]' : 'left-[3px]')} />
      </span>
    </button>
  )
}

function SmallSwitchTile({ icon, title, hint, on, onChange }: { icon: IconName; title: string; hint: string; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      title={hint}
      onClick={() => onChange(!on)}
      className={clsx('flex h-[76px] items-center gap-3 rounded-[22px] px-3.5 py-3 text-left transition-colors', on ? 'bg-accent/16 hover:bg-accent/20' : 'bg-white/7 hover:bg-white/10')}
    >
      <span className={clsx('flex h-9 w-9 shrink-0 items-center justify-center rounded-full', on ? 'bg-accent text-accent-ink' : 'bg-white/12 text-fg-2')}>
        <Icon name={icon} size={17} strokeWidth={on ? 2 : 1.8} />
      </span>
      <span className="flex min-w-0 flex-col">
        <span className={clsx('text-sm font-bold', on && 'text-[#FFD1DD]')}>{title}</span>
        <span className={clsx('text-[11px]', on ? 'text-accent-soft' : 'text-muted')}>{on ? '开' : '关'}</span>
      </span>
    </button>
  )
}

/**
 * A slider that fills its whole box, like a phone's control centre. Drag anywhere on it (it moves
 * by how far you drag, so a tap never jumps the level); arrow keys step by 5.
 * White at rest, red while dragged, grey when it can't be used.
 */
function FillSlider({
  label,
  text,
  value,
  onChange,
  disabled,
  vertical,
  icon,
  className,
  track = 'bg-white/7',
}: {
  label: string
  /** Shown on the slider when shorter than `label` (which is what screen readers hear). */
  text?: string
  value: number
  onChange: (v: number) => void
  disabled?: boolean
  vertical?: boolean
  icon?: IconName
  className?: string
  /** Background of the empty part. */
  track?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const start = useRef<{ at: number; value: number } | null>(null)
  const [drag, setDrag] = useState(false)
  const clamp = (v: number) => Math.round(Math.max(0, Math.min(100, v)))
  const pos = (e: React.PointerEvent) => (vertical ? -e.clientY : e.clientX)
  const size = () => {
    const r = ref.current?.getBoundingClientRect()
    return Math.max(1, (vertical ? r?.height : r?.width) ?? 1)
  }
  const end = () => {
    start.current = null
    setDrag(false)
  }

  const pct = clamp(value)
  const fill = disabled ? '#34343E' : drag ? '#FF4D7E' : '#ECECF0'
  const numClass = disabled ? 'text-muted' : drag ? 'text-[#FFD1DD]' : 'text-fg'
  // Text that sits on the fill turns dark so it stays readable.
  const onFill = (from: number) => !disabled && pct > from

  return (
    <div
      ref={ref}
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      aria-disabled={disabled || undefined}
      aria-orientation={vertical ? 'vertical' : 'horizontal'}
      onPointerDown={(e) => {
        if (disabled || e.button !== 0) return
        e.currentTarget.setPointerCapture(e.pointerId)
        start.current = { at: pos(e), value: pct }
        setDrag(true)
      }}
      onPointerMove={(e) => {
        if (!start.current) return
        onChange(clamp(start.current.value + ((pos(e) - start.current.at) / size()) * 100))
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onKeyDown={(e) => {
        if (disabled) return
        const step = { ArrowUp: 5, ArrowRight: 5, ArrowDown: -5, ArrowLeft: -5, PageUp: 10, PageDown: -10 }[e.key]
        if (step !== undefined) onChange(clamp(pct + step))
        else if (e.key === 'Home') onChange(0)
        else if (e.key === 'End') onChange(100)
        else return
        e.preventDefault()
      }}
      style={{ touchAction: 'none' }}
      className={clsx(
        'relative select-none overflow-hidden outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-fg/60',
        disabled ? 'cursor-not-allowed bg-white/4' : clsx(drag ? 'cursor-grabbing bg-accent/16 ring-2 ring-accent/55' : clsx('cursor-grab', track)),
        vertical && 'h-[200px] rounded-3xl',
        className,
      )}
    >
      <div
        aria-hidden="true"
        className="absolute bottom-0 left-0 transition-colors duration-150"
        style={vertical ? { right: 0, height: `${pct}%`, background: fill } : { top: 0, width: `${pct}%`, background: fill }}
      />
      {vertical ? (
        <>
          <span aria-hidden="true" className="absolute top-3 right-0 left-0 flex flex-col items-center">
            <span className={clsx('num text-lg font-bold', onFill(88) ? 'text-[#16161E]' : numClass)}>{pct}</span>
            <span className={clsx('text-xs', onFill(80) ? 'text-[#3F3F46]' : disabled ? 'text-subtle' : drag ? 'text-accent-soft' : 'text-muted')}>{label}</span>
          </span>
          {icon && (
            <Icon
              name={icon}
              size={20}
              strokeWidth={2}
              aria-hidden="true"
              className={clsx('absolute bottom-3.5 left-1/2 -ml-2.5', disabled ? 'text-subtle' : onFill(12) ? (drag ? 'text-accent-ink' : 'text-[#16161E]') : 'text-fg-2')}
            />
          )}
        </>
      ) : (
        <span aria-hidden="true" className="absolute inset-0 flex items-center justify-between px-3">
          {icon ? (
            <Icon name={icon} size={17} strokeWidth={2} className={disabled ? 'text-faint' : onFill(12) ? (drag ? 'text-accent-ink' : 'text-[#16161E]') : 'text-fg-2'} />
          ) : (
            <span className={clsx('text-[13px] font-semibold', disabled ? 'text-faint' : onFill(28) ? (drag ? 'text-accent-ink' : 'text-[#16161E]') : 'text-fg-2')}>{text ?? label}</span>
          )}
          <span className={clsx('num text-[15px] font-bold', onFill(86) ? 'text-[#16161E]' : numClass)}>{pct}</span>
        </span>
      )}
    </div>
  )
}
