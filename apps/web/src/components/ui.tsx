import clsx from 'clsx'
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { Song } from '@shared/types'
import { imgUrl } from '../lib/api'
import type { PillKind, SongStatus } from '../lib/format'
import { Icon, type IconName } from './icons'

// ---------- Cover ----------

const fallbackGradients = [
  ['#FF6B8B', '#7B2FF7'],
  ['#F6C177', '#C2410C'],
  ['#22D3EE', '#1E3A8A'],
  ['#34D399', '#065F46'],
  ['#A78BFA', '#1E1B4B'],
  ['#FDE68A', '#F97316'],
  ['#94A3B8', '#0F766E'],
]

export function coverFallback(id: number) {
  const [a, b] = fallbackGradients[Math.abs(id) % fallbackGradients.length]
  return `radial-gradient(circle at 72% 26%, rgba(255,255,255,0.42) 0%, rgba(255,255,255,0) 42%), linear-gradient(135deg, ${a} 0%, ${b} 100%)`
}

export function Cover({
  song,
  url,
  seed = 0,
  size,
  px = 300,
  className,
  style,
}: {
  song?: Pick<Song, 'id' | 'album'>
  url?: string
  seed?: number
  size?: number
  px?: number
  className?: string
  style?: CSSProperties
}) {
  const src = imgUrl(url ?? song?.album.picUrl, px)
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [src])
  return (
    <div
      aria-hidden="true"
      className={clsx('shrink-0 overflow-hidden bg-white/5', className)}
      style={{ width: size, height: size, background: coverFallback(song?.id ?? seed), ...style }}
    >
      {src && !failed && (
        <img
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
          className="h-full w-full object-cover"
        />
      )}
    </div>
  )
}

// ---------- Status pill ----------

const pillStyle: Record<PillKind, { cls: string; icon: IconName; spin?: boolean }> = {
  ready: { cls: 'bg-[rgba(74,222,128,0.12)] text-ok', icon: 'check' },
  original: { cls: 'bg-white/7 text-fg-2', icon: 'note' },
  third: { cls: 'bg-[rgba(96,165,250,0.12)] text-info', icon: 'globe' },
  proc: { cls: 'bg-[rgba(251,191,36,0.12)] text-warn', icon: 'loader', spin: true },
  download: { cls: 'bg-[rgba(251,191,36,0.12)] text-warn', icon: 'download' },
  queued: { cls: 'bg-white/7 text-fg-2', icon: 'clock' },
  new: { cls: 'bg-white/5 text-muted', icon: 'sparkle' },
  vip: { cls: 'bg-white/5 text-muted', icon: 'lock' },
  nosource: { cls: 'bg-white/5 text-muted', icon: 'alert' },
  error: { cls: 'bg-[rgba(255,77,126,0.12)] text-accent-soft', icon: 'alert' },
}

export function StatusPill({ status, large }: { status: SongStatus; large?: boolean }) {
  const s = pillStyle[status.kind]
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full font-medium',
        large ? 'h-[30px] px-3 text-[15px]' : 'h-7 px-2.5 text-[13px]',
        s.cls,
      )}
    >
      <Icon name={s.icon} size={large ? 16 : 14} strokeWidth={2.1} className={s.spin ? 'ktv-spin' : undefined} />
      {status.label}
    </span>
  )
}

export const dotColor: Record<PillKind, string> = {
  ready: '#4ADE80',
  original: '#D4D4DC',
  third: '#60A5FA',
  proc: '#FBBF24',
  download: '#FBBF24',
  queued: '#8E8E99',
  new: '#8E8E99',
  vip: '#8E8E99',
  nosource: '#8E8E99',
  error: '#FF4D7E',
}

// ---------- Small pieces ----------

export function ProgressBar({ value, color = '#FBBF24', className }: { value: number; color?: string; className?: string }) {
  return (
    <div aria-hidden="true" className={clsx('h-1 overflow-hidden rounded-full bg-white/12', className)}>
      <div
        className="h-full rounded-full transition-[width] duration-500"
        style={{ width: `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`, background: color }}
      />
    </div>
  )
}

export function Eq({ color = '#FF8FAB' }: { color?: string }) {
  return (
    <span aria-hidden="true" className="ktv-eq inline-flex h-3 items-end gap-[2px]">
      <span className="h-2 w-[3px] rounded-[1px]" style={{ background: color }} />
      <span className="h-3 w-[3px] rounded-[1px]" style={{ background: color }} />
      <span className="h-1.5 w-[3px] rounded-[1px]" style={{ background: color }} />
    </span>
  )
}

export function IconButton({
  icon,
  label,
  onClick,
  size = 36,
  iconSize = 18,
  className,
  disabled,
}: {
  icon: IconName
  label: string
  onClick?: () => void
  size?: number
  iconSize?: number
  className?: string
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className={clsx(
        'inline-flex shrink-0 items-center justify-center rounded-[10px] text-muted transition-colors hover:bg-white/10 hover:text-fg disabled:opacity-40',
        className,
      )}
      style={{ width: size, height: size }}
    >
      <Icon name={icon} size={iconSize} strokeWidth={1.9} />
    </button>
  )
}

export function Range({
  value,
  onChange,
  label,
  min = 0,
  max = 100,
  color = '#FF4D7E',
}: {
  value: number
  onChange: (v: number) => void
  label: string
  min?: number
  max?: number
  color?: string
}) {
  const pct = ((value - min) / (max - min)) * 100
  return (
    <input
      type="range"
      aria-label={label}
      min={min}
      max={max}
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      className="ktv-range"
      style={{ ['--range-pct' as string]: pct + '%', ['--range-fill' as string]: color }}
    />
  )
}

// ---------- Dialog ----------

export function Dialog({
  open,
  onClose,
  title,
  children,
  width = 480,
  sheet,
}: {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
  width?: number
  /** On phones (< 640px) dock to the bottom edge like a sheet. */
  sheet?: boolean
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) d.showModal()
    if (!open && d.open) d.close()
  }, [open])
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose()
      }}
      className={clsx(
        'm-auto max-h-[90vh] w-[calc(100%-32px)] overflow-visible rounded-3xl border border-white/10 bg-panel p-0 text-fg shadow-[0_30px_80px_rgba(0,0,0,0.6)] backdrop:bg-black/60 backdrop:backdrop-blur-sm',
        sheet &&
          'max-sm:mb-0 max-sm:w-full max-sm:max-w-full! max-sm:rounded-b-none max-sm:border-b-0 max-sm:pb-[env(safe-area-inset-bottom)]',
      )}
      style={{ maxWidth: width }}
    >
      {open && (
        <div className="flex max-h-[90vh] flex-col">
          <div className="flex items-center justify-between px-6 pt-5 pb-2">
            <h2 className="m-0 text-lg font-bold">{title}</h2>
            <IconButton icon="x" label="关闭" onClick={onClose} size={40} />
          </div>
          <div className="overflow-y-auto px-6 pb-6">{children}</div>
        </div>
      )}
    </dialog>
  )
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={clsx(
        'relative h-7 w-12 shrink-0 rounded-full transition-colors',
        checked ? 'bg-accent' : 'bg-white/15',
      )}
    >
      <span
        className={clsx(
          'absolute top-1 left-1 h-5 w-5 rounded-full bg-white shadow transition-transform',
          checked && 'translate-x-5',
        )}
      />
    </button>
  )
}

export function Spinner({ size = 20 }: { size?: number }) {
  return <Icon name="loader" size={size} strokeWidth={2} className="ktv-spin" />
}

export function EmptyNote({ children }: { children: ReactNode }) {
  return <p className="m-0 py-10 text-center text-sm text-muted">{children}</p>
}

/** Inline error state for a failed query, with a 重试 button. */
export function QueryError({
  error,
  onRetry,
  retrying,
  compact,
}: {
  error: unknown
  onRetry: () => void
  retrying?: boolean
  compact?: boolean
}) {
  const msg = error instanceof Error && error.message ? error.message : '加载失败'
  return (
    <div
      role="alert"
      className={clsx('flex flex-col items-center gap-3 text-center', compact ? 'py-6' : 'py-12')}
    >
      <span className="flex h-11 w-11 items-center justify-center rounded-full bg-white/6 text-accent-soft">
        <Icon name="alert" size={20} />
      </span>
      <div className="flex flex-col gap-1">
        <span className="text-[15px] font-semibold">加载失败</span>
        <span className="max-w-[320px] text-[13px] leading-5 text-muted">{msg}</span>
      </div>
      <button
        type="button"
        onClick={onRetry}
        disabled={retrying}
        className="flex h-10 items-center gap-2 rounded-xl bg-white/8 px-4 text-sm font-semibold whitespace-nowrap hover:bg-white/12 disabled:opacity-60"
      >
        {retrying ? <Spinner size={16} /> : <Icon name="refresh" size={16} />}
        重试
      </button>
    </div>
  )
}
