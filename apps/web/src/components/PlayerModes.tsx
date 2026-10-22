import clsx from 'clsx'
import type { DisplayMode, TrackMode } from '@shared/types'
import { sendCommand, useApp } from '../store/app'
import { Icon, type IconName } from './icons'

type Size = 'sm' | 'md' | 'lg'

const sizes: Record<Size, { wrap: string; btn: string; icon: number }> = {
  sm: { wrap: 'h-9 rounded-xl p-[3px]', btn: 'h-full rounded-[9px] px-3 text-[13px]', icon: 14 },
  md: { wrap: 'h-11 rounded-2xl p-1', btn: 'h-full rounded-xl px-3 text-sm', icon: 16 },
  lg: { wrap: 'h-16 rounded-[20px] px-2.5 py-2.5', btn: 'h-11 rounded-[14px] px-4.5 text-[17px]', icon: 19 },
}

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
        'inline-flex items-center gap-1',
        size === 'lg' ? 'glass' : 'bg-white/6',
        stretch && 'grid w-full grid-flow-col auto-cols-fr',
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

/** 伴唱 / 原唱 switch for the current song; "仅原曲" when the song has no stems. */
export function TrackModeToggle({ size = 'md', stretch, className }: { size?: Size; stretch?: boolean; className?: string }) {
  const trackMode = useApp((s) => s.state.player.trackMode)
  const cur = useApp((s) => s.state.player.current)
  const track = useApp((s) => (cur ? s.state.tracks[cur.song.id] : undefined))
  if (!cur) return null
  if (track?.status === 'ready' && !track.hasStems) {
    const s = sizes[size]
    return (
      <div
        className={clsx(
          'inline-flex items-center justify-center gap-1.5 text-subtle',
          size === 'lg' ? 'glass px-5' : 'bg-white/4 px-3',
          s.wrap,
          stretch && 'w-full',
          className,
        )}
        title="这首歌没有分离出伴奏，只能播放原曲"
      >
        <Icon name="note" size={s.icon} />
        <span className={size === 'lg' ? 'text-[17px]' : size === 'md' ? 'text-sm' : 'text-[13px]'}>仅原曲</span>
      </div>
    )
  }
  return (
    <Segmented<TrackMode>
      label="伴唱或原唱"
      size={size}
      stretch={stretch}
      className={className}
      value={trackMode}
      options={[
        ['karaoke', '伴唱', 'wave'],
        ['original', '原唱', 'mic'],
      ]}
      onChange={(v) => sendCommand({ action: 'set', trackMode: v })}
    />
  )
}

/** 舞台 / MV display mode of the TV page. */
export function DisplayModeToggle({ size = 'md', stretch, className }: { size?: Size; stretch?: boolean; className?: string }) {
  const displayMode = useApp((s) => s.state.player.displayMode ?? 'stage')
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
      onChange={(v) => sendCommand({ action: 'set', displayMode: v })}
    />
  )
}
