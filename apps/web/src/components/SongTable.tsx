import clsx from 'clsx'
import type { Song } from '@shared/types'
import { artistsText, fmtMs } from '../lib/format'
import { playQueuedNow, useEnqueue, useStatusOf } from '../lib/hooks'
import { useApp } from '../store/app'
import { Icon } from './icons'
import { Cover, Eq, IconButton, StatusPill } from './ui'

// Columns follow the table's own width (container queries), not the viewport: the desk's
// main column is much narrower than the window when the sidebar and queue are shown.
const cols =
  'grid-cols-[28px_minmax(0,1fr)_auto] @2xl:grid-cols-[32px_minmax(0,1fr)_136px_auto] @4xl:grid-cols-[36px_minmax(0,2.2fr)_minmax(0,1fr)_52px_136px_auto]'

/** 立即唱: skip the current song and sing this one now. */
function SingNowButton({ song, compact }: { song: Song; compact?: boolean }) {
  const enqueue = useEnqueue()
  const queue = useApp((s) => s.state.queue)
  const queued = queue.find((q) => q.song.id === song.id)
  return (
    <IconButton
      icon="play"
      label={`立即唱 ${song.name}`}
      onClick={() => (queued ? playQueuedNow(queued) : enqueue(song, 'now'))}
      className={clsx('bg-white/6 text-fg-2 hover:text-accent-soft', compact && 'hidden @md:inline-flex')}
    />
  )
}

export function SongActions({ song, compact }: { song: Song; compact?: boolean }) {
  const statusOf = useStatusOf()
  const enqueue = useEnqueue()
  const st = statusOf(song)
  if (st.isCurrent)
    return (
      <span className="inline-flex h-9 shrink-0 items-center gap-2 rounded-[10px] bg-[rgba(255,77,126,0.12)] px-3.5 text-sm font-semibold whitespace-nowrap text-accent-soft">
        <Eq />
        演唱中
      </span>
    )
  if (st.inQueue)
    return (
      <div className="flex shrink-0 items-center gap-1.5">
        <SingNowButton song={song} />
        <span className="inline-flex h-9 items-center rounded-[10px] bg-white/6 px-3.5 text-sm whitespace-nowrap text-muted">已点</span>
      </div>
    )
  if (st.kind === 'vip')
    return (
      <button
        type="button"
        disabled
        className="h-9 shrink-0 rounded-[10px] border border-white/10 px-3.5 text-sm whitespace-nowrap text-subtle"
        title="这首歌需要会员，账号没有权限播放完整版"
      >
        不可点
      </button>
    )
  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <SingNowButton song={song} />
      <IconButton
        icon="top"
        label={`插播 ${song.name}`}
        onClick={() => enqueue(song, 'next')}
        className={clsx('bg-white/6 text-fg-2', compact && 'hidden @md:inline-flex')}
      />
      <button
        type="button"
        onClick={() => enqueue(song, 'end')}
        className="h-9 shrink-0 rounded-[10px] bg-accent px-4 text-sm font-bold whitespace-nowrap text-accent-ink transition-transform hover:brightness-110 active:scale-95"
      >
        点歌
      </button>
    </div>
  )
}

export function SongTable({ songs, start = 0 }: { songs: Song[]; start?: number }) {
  const statusOf = useStatusOf()
  return (
    <div className="@container -mx-3 flex flex-col">
      <div
        className={clsx(
          'grid h-9 items-center gap-3 border-b border-white/6 px-3 text-xs tracking-[0.08em] whitespace-nowrap text-subtle @4xl:gap-4',
          cols,
        )}
      >
        <span>#</span>
        <span>歌曲</span>
        <span className="hidden @4xl:block">专辑</span>
        <span className="hidden @4xl:block">时长</span>
        <span className="hidden @2xl:block">状态</span>
        <span className="text-right">操作</span>
      </div>
      {songs.map((song, i) => {
        const st = statusOf(song)
        return (
          <div
            key={song.id + '-' + i}
            className={clsx('grid min-h-[68px] items-center gap-3 rounded-[14px] px-3 py-2 hover:bg-white/4 @4xl:gap-4', cols)}
          >
            <span className="num text-sm text-subtle">{String(start + i + 1).padStart(2, '0')}</span>
            <div className="flex min-w-0 items-center gap-3.5">
              <Cover song={song} px={100} className="h-[46px] w-[46px] rounded-[10px]" />
              <div className="flex min-w-0 flex-col gap-[3px]">
                <span className="truncate text-[15px] font-semibold">
                  {song.name}
                  {song.alias[0] && <span className="ml-1 font-normal text-muted">（{song.alias[0]}）</span>}
                </span>
                <div className="flex min-w-0 items-center gap-2 text-[13px] text-muted">
                  {song.mvId > 0 && (
                    <span className="num rounded border border-white/28 px-[5px] py-px text-[10px] font-bold text-fg-2">MV</span>
                  )}
                  <span className="truncate">{artistsText(song)}</span>
                </div>
                <span className="@2xl:hidden">
                  {st.kind !== 'new' && <StatusPill status={st} />}
                </span>
              </div>
            </div>
            <span className="hidden truncate text-sm text-muted @4xl:block">{song.album.name}</span>
            <span className="num hidden text-sm text-muted @4xl:block">{fmtMs(song.duration)}</span>
            <div className="hidden min-w-0 @2xl:block">
              <StatusPill status={st} />
            </div>
            <div className="flex justify-end">
              <SongActions song={song} compact />
            </div>
          </div>
        )
      })}
    </div>
  )
}

export function RecCard({ song }: { song: Song }) {
  const enqueue = useEnqueue()
  const statusOf = useStatusOf()
  const st = statusOf(song)
  const disabled = st.kind === 'vip' || st.inQueue || st.isCurrent
  const reveal =
    'transition-all duration-200 group-hover:translate-y-0 group-hover:opacity-100 group-focus-within:translate-y-0 group-focus-within:opacity-100 [@media(hover:hover)]:translate-y-1.5 [@media(hover:hover)]:opacity-0'
  return (
    <div className="group flex min-w-0 flex-col gap-2.5">
      <div className="relative aspect-square overflow-hidden rounded-[18px] shadow-[0_14px_30px_rgba(0,0,0,0.35)]">
        <Cover song={song} px={400} className="h-full w-full transition-transform duration-500 group-hover:scale-[1.04]" />
        {song.mvId > 0 && (
          <span className="num absolute top-2.5 left-2.5 inline-flex h-[22px] items-center rounded-md bg-ink/60 px-2 text-xs font-semibold">
            MV
          </span>
        )}
        {st.kind === 'vip' && (
          <span className="absolute top-2.5 right-2.5 inline-flex h-[22px] items-center gap-1 rounded-md bg-ink/60 px-2 text-xs text-fg-2">
            <Icon name="lock" size={12} /> 会员
          </span>
        )}
        {(st.inQueue || st.isCurrent) && (
          <span className="absolute right-2.5 bottom-2.5 inline-flex h-7 items-center gap-1.5 rounded-full bg-ink/70 px-2.5 text-xs text-fg-2">
            {st.isCurrent ? <Eq /> : <Icon name="check" size={13} />}
            {st.isCurrent ? '演唱中' : '已点'}
          </span>
        )}
        {!disabled && (
          <div className={clsx('absolute right-2.5 bottom-2.5 flex items-center gap-1.5', reveal)}>
            <button
              type="button"
              onClick={() => enqueue(song, 'now')}
              aria-label={`立即唱 ${song.name}`}
              title="立即唱"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-ink/70 text-fg shadow-[0_8px_20px_rgba(0,0,0,0.4)] backdrop-blur hover:bg-ink/85"
            >
              <Icon name="play" size={16} />
            </button>
            <button
              type="button"
              onClick={() => enqueue(song, 'next')}
              aria-label={`插播 ${song.name}`}
              title="插播"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-ink/70 text-fg shadow-[0_8px_20px_rgba(0,0,0,0.4)] backdrop-blur hover:bg-ink/85"
            >
              <Icon name="top" size={16} />
            </button>
            <button
              type="button"
              onClick={() => enqueue(song)}
              aria-label={`点歌 ${song.name}`}
              title="点歌"
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-accent text-accent-ink shadow-[0_8px_20px_rgba(0,0,0,0.4)]"
            >
              <Icon name="plus" size={22} strokeWidth={2.2} />
            </button>
          </div>
        )}
      </div>
      <div className="flex min-w-0 flex-col gap-0.5 px-0.5">
        <span className="truncate text-[15px] font-semibold">{song.name}</span>
        <span className="truncate text-[13px] text-muted">{artistsText(song)}</span>
      </div>
    </div>
  )
}
