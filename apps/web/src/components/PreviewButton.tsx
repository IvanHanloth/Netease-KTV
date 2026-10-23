import clsx from 'clsx'
import type { Song } from '@shared/types'
import { togglePreview, usePreview } from '../lib/preview'
import { Icon } from './icons'

/**
 * 试听: plays a low-quality copy of the song on this device only. Shows a progress ring
 * while playing; tapping again stops it.
 */
export function PreviewButton({
  song,
  size = 36,
  className,
  variant = 'plain',
}: {
  song: Pick<Song, 'id' | 'name'>
  size?: number
  className?: string
  /** 'overlay' = dark translucent disc for use on top of cover art. */
  variant?: 'plain' | 'overlay'
}) {
  const active = usePreview((s) => s.songId === song.id)
  const loading = usePreview((s) => s.songId === song.id && s.loading)
  const progress = usePreview((s) => (s.songId === song.id ? s.progress : 0))
  const r = size / 2 - 2
  const c = 2 * Math.PI * r
  const label = active ? `停止试听 ${song.name}` : `试听 ${song.name}`
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      title={active ? '停止试听' : '试听（在本机播放片段）'}
      onClick={(e) => {
        e.stopPropagation()
        togglePreview(song)
      }}
      style={{ width: size, height: size }}
      className={clsx(
        'relative inline-flex shrink-0 items-center justify-center rounded-full transition-colors',
        variant === 'overlay'
          ? 'bg-ink/70 text-fg shadow-[0_8px_20px_rgba(0,0,0,0.4)] backdrop-blur hover:bg-ink/85'
          : active
            ? 'bg-[rgba(255,77,126,0.14)] text-accent-soft'
            : 'bg-white/6 text-fg-2 hover:bg-white/10 hover:text-fg',
        className,
      )}
    >
      {active && (
        <svg aria-hidden="true" width={size} height={size} className="absolute inset-0 -rotate-90">
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.12)" strokeWidth="2" />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke="#FF4D7E"
            strokeWidth="2"
            strokeLinecap="round"
            strokeDasharray={c}
            strokeDashoffset={c * (1 - progress)}
            className={clsx(loading && 'ktv-spin origin-center')}
            style={loading ? { strokeDasharray: `${c * 0.25} ${c}` } : undefined}
          />
        </svg>
      )}
      <Icon name={active ? 'stop' : 'headphones'} size={Math.round(size * 0.44)} />
    </button>
  )
}
