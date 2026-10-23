import clsx from 'clsx'
import type { DisplayMode, TrackMode } from '@shared/types'
import { sendCommand, useApp } from '../store/app'
import { Icon, type IconName } from './icons'

type Size = 'sm' | 'md' | 'lg' | 'tv'

const sizes: Record<Size, { wrap: string; btn: string; icon: number }> = {
  sm: { wrap: 'h-9 rounded-xl p-[3px]', btn: 'h-full rounded-[9px] px-3 text-[13px]', icon: 14 },
  md: { wrap: 'h-11 rounded-2xl p-1', btn: 'h-full rounded-xl px-3 text-sm', icon: 16 },
  lg: { wrap: 'h-16 rounded-[20px] px-2.5 py-2.5', btn: 'h-11 rounded-[14px] px-4.5 text-[17px]', icon: 19 },
  /** TV control bar: same height as the other bar controls, never wraps. */
  tv: { wrap: 'h-14 shrink-0 rounded-[18px] p-[7px]', btn: 'h-full rounded-[12px] px-3.5 text-[15px]', icon: 17 },
}

const isGlass = (size: Size) => size === 'lg' || size === 'tv'

export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  size = 'md',
  stretch,
  className,
}: {
  label: string
  value: T
  options: readonly (readonly [T, string, IconName?])[]
  onChange: (v: T) => void
  size?: Size
  stretch?: boolean
  className?: string
}) {
  const s = sizes[size]
  return (
    <div
      role="group"
      aria-label={label}
      className={clsx(
        'items-center gap-1',
        isGlass(size) ? 'glass' : 'bg-white/6',
        stretch ? 'grid w-full auto-cols-fr grid-flow-col' : 'inline-flex',
        s.wrap,
        className,
      )}
    >
      {options.map(([v, text, icon]) => {
        const on = v === value
        return (
          <button
            key={v}
            type="button"
            aria-pressed={on}
            onClick={() => !on && onChange(v)}
            className={clsx(
              'inline-flex items-center justify-center gap-1.5 whitespace-nowrap transition-colors duration-200',
              s.btn,
              on ? 'bg-fg font-semibold text-ink' : 'text-[#C8C8D0] hover:text-fg',
            )}
          >
            {icon && <Icon name={icon} size={s.icon} />}
            {text}
          </button>
        )
      })}
    </div>
  )
}

/** 伴唱 / 领唱 / 原唱 switch for the current song; "仅原曲" when the song has no stems. */
export function TrackModeToggle({ size = 'md', stretch, className }: { size?: Size; stretch?: boolean; className?: string }) {
  const trackMode = useApp((s) => s.state.player.trackMode)
  const leadVocal = useApp((s) => !!s.state.player.leadVocal)
  const cur = useApp((s) => s.state.player.current)
  const track = useApp((s) => (cur ? s.state.tracks[cur.song.id] : undefined))
  if (!cur) return null
  if (track?.status === 'ready' && !track.hasStems) {
    const s = sizes[size]
    return (
      <div
        className={clsx(
          'inline-flex items-center justify-center gap-1.5 text-subtle',
          isGlass(size) ? 'glass px-5' : 'bg-white/4 px-3',
          s.wrap,
          stretch && 'w-full',
          className,
        )}
        title="这首歌没有分离出伴奏，只能播放原曲"
      >
        <Icon name="note" size={s.icon} />
        <span className={clsx('whitespace-nowrap', size === 'lg' ? 'text-[17px]' : size === 'tv' ? 'text-[15px]' : size === 'md' ? 'text-sm' : 'text-[13px]')}>
          仅原曲
        </span>
      </div>
    )
  }
  // 领唱 = 伴唱 + the original lead vocal on the first line after each interlude.
  const value: VocalMode = trackMode === 'original' ? 'original' : leadVocal ? 'lead' : 'karaoke'
  return (
    <Segmented<VocalMode>
      label="伴唱、领唱或原唱"
      size={size}
      stretch={stretch}
      className={className}
      value={value}
      options={[
        ['karaoke', '伴唱', 'wave'],
        ['lead', '领唱', 'note'],
        ['original', '原唱', 'mic'],
      ]}
      onChange={(v) => sendCommand({ action: 'set', ...vocalModeCommand(v) })}
    />
  )
}

export type VocalMode = 'karaoke' | 'lead' | 'original'

/** Player settings for a 伴唱 / 领唱 / 原唱 choice. */
export function vocalModeCommand(v: VocalMode): { trackMode: TrackMode; leadVocal?: boolean } {
  if (v === 'original') return { trackMode: 'original' }
  return { trackMode: 'karaoke', leadVocal: v === 'lead' }
}

/**
 * Compact "tap to switch" button: shows the current mode, each tap moves to the next one.
 * Small dots show where the current mode sits in the cycle. Used where a segmented control
 * doesn't fit (the desk's now-singing card).
 */
function CycleButton<T extends string>({
  label,
  value,
  modes,
  onChange,
  disabled,
  disabledText,
  className,
}: {
  label: string
  value: T
  modes: readonly (readonly [T, string, IconName])[]
  onChange: (v: T) => void
  disabled?: boolean
  disabledText?: string
  className?: string
}) {
  const idx = Math.max(0, modes.findIndex(([v]) => v === value))
  const [, text, icon] = modes[idx]!
  const next = modes[(idx + 1) % modes.length]!
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onChange(next[0])}
      aria-label={disabled ? `${label}：${disabledText}` : `${label}：${text}，点击切换到${next[1]}`}
      title={disabled ? disabledText : `点击切换（${modes.map(([, t]) => t).join(' → ')}）`}
      className={clsx(
        'flex h-9 min-w-0 items-center justify-center gap-1.5 rounded-xl px-2.5 text-[13px] whitespace-nowrap transition-colors',
        disabled ? 'cursor-not-allowed bg-white/4 text-subtle' : 'bg-white/8 text-fg hover:bg-white/14',
        className,
      )}
    >
      <Icon name={disabled ? 'note' : icon} size={14} className="shrink-0" />
      <span className="truncate font-semibold">{disabled ? disabledText : text}</span>
      {!disabled && (
        <span aria-hidden="true" className="ml-0.5 flex shrink-0 gap-[3px]">
          {modes.map(([v], i) => (
            <span key={v} className={clsx('h-1 w-1 rounded-full', i === idx ? 'bg-accent' : 'bg-white/25')} />
          ))}
        </span>
      )}
    </button>
  )
}

/** Tap to cycle 伴唱 → 领唱 → 原唱. */
export function VocalModeButton({ className }: { className?: string }) {
  const trackMode = useApp((s) => s.state.player.trackMode)
  const leadVocal = useApp((s) => !!s.state.player.leadVocal)
  const cur = useApp((s) => s.state.player.current)
  const track = useApp((s) => (cur ? s.state.tracks[cur.song.id] : undefined))
  if (!cur) return null
  const noStems = track?.status === 'ready' && !track.hasStems
  const value: VocalMode = trackMode === 'original' ? 'original' : leadVocal ? 'lead' : 'karaoke'
  return (
    <CycleButton<VocalMode>
      label="演唱模式"
      value={value}
      modes={[
        ['karaoke', '伴唱', 'wave'],
        ['lead', '领唱', 'note'],
        ['original', '原唱', 'mic'],
      ]}
      onChange={(v) => sendCommand({ action: 'set', ...vocalModeCommand(v) })}
      disabled={noStems}
      disabledText="仅原曲"
      className={className}
    />
  )
}

/** Tap to switch the TV between 舞台 and MV. */
export function DisplayModeButton({ className }: { className?: string }) {
  const displayMode = useApp((s) => s.state.player.displayMode ?? 'stage')
  return (
    <CycleButton<DisplayMode>
      label="主屏显示模式"
      value={displayMode}
      modes={[
        ['stage', '舞台', 'lyrics'],
        ['mv', 'MV', 'video'],
      ]}
      onChange={(v) => sendCommand({ action: 'set', displayMode: v })}
      className={className}
    />
  )
}

/** 舞台 / MV display mode of the TV page. */
/**
 * 舞台 / MV. Controls the sound-playing TV (synced to every remote) unless `value` / `onChange`
 * are given: a silent extra screen switches only itself.
 */
export function DisplayModeToggle({
  size = 'md',
  stretch,
  className,
  value,
  onChange,
}: {
  size?: Size
  stretch?: boolean
  className?: string
  value?: DisplayMode
  onChange?: (v: DisplayMode) => void
}) {
  const synced = useApp((s) => s.state.player.displayMode ?? 'stage')
  const displayMode = value ?? synced
  return (
    <Segmented<DisplayMode>
      label="主屏显示模式"
      size={size}
      stretch={stretch}
      className={className}
      value={displayMode}
      options={[
        ['stage', '舞台', 'lyrics'],
        ['mv', 'MV', 'video'],
      ]}
      onChange={(v) => (onChange ? onChange(v) : sendCommand({ action: 'set', displayMode: v }))}
    />
  )
}
