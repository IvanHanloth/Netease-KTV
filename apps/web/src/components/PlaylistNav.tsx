import clsx from 'clsx'
import { useState } from 'react'
import type { PlaylistSummary } from '@shared/types'
import { imgUrl } from '../lib/api'
import { Icon } from './icons'

/** Small playlist cover; a gradient tile when there is no cover (or it fails to load). */
export function PlaylistThumb({ p, liked, className }: { p: PlaylistSummary; liked?: boolean; className?: string }) {
  const [failed, setFailed] = useState(false)
  const src = !failed ? imgUrl(p.coverUrl, 96) : undefined
  return (
    <span className={clsx('relative block h-8 w-8 shrink-0', className)}>
      {src ? (
        <img
          src={src}
          alt=""
          loading="lazy"
          onError={() => setFailed(true)}
          className="h-full w-full rounded-lg object-cover shadow-[0_4px_10px_rgba(0,0,0,0.35)]"
        />
      ) : (
        <span className="flex h-full w-full items-center justify-center rounded-lg bg-[linear-gradient(135deg,#3B2A4A,#1C1C26)] text-fg-2">
          <Icon name="playlist" size={15} />
        </span>
      )}
      {liked && (
        <span className="absolute -right-1 -bottom-1 flex h-4 w-4 items-center justify-center rounded-full bg-accent text-accent-ink shadow-[0_2px_6px_rgba(0,0,0,0.5)]">
          <Icon name="heart" size={10} />
        </span>
      )}
    </span>
  )
}

/** Sidebar row for a playlist: cover + name. */
export function PlaylistNavButton({
  p,
  label,
  liked,
  active,
  onClick,
}: {
  p: PlaylistSummary
  label?: string
  liked?: boolean
  active?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      title={label ?? p.name}
      className={clsx(
        'flex h-11 w-full min-w-0 items-center gap-3 rounded-xl px-2.5 text-left text-sm transition-colors hover:bg-white/5',
        active ? 'bg-white/7 font-semibold text-fg' : 'text-[#C8C8D0]',
      )}
    >
      <PlaylistThumb p={p} liked={liked} />
      <span className="truncate">{label ?? p.name}</span>
    </button>
  )
}
