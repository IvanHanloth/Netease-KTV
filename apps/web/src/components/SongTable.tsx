import clsx from 'clsx'
import type { Song } from '@shared/types'
import { artistsText, fmtMs } from '../lib/format'
import { useDeskNav } from '../lib/deskNav'
import { enqueueKey, useEnqueue, useIsPending, useStatusOf } from '../lib/hooks'
import { Icon } from './icons'
import { PreviewButton } from './PreviewButton'
import { Cover, Eq, IconButton, Spinner, StatusPill } from './ui'

// Columns follow the table's own width (container queries), not the viewport: the desk's
// main column is much narrower than the window when the sidebar and queue are shown.
// Every row is its own grid, so the actions column has a fixed width once other columns sit to
// its left: with `auto`, a row showing "演唱中" or "已点" (narrower than 试听 + 插播 + 点歌) would
// shift its album / duration / status columns out of line with the rest.
const cols =
  'grid-cols-[28px_minmax(0,1fr)_auto] @2xl:grid-cols-[32px_minmax(0,1fr)_136px_168px] @4xl:grid-cols-[36px_minmax(0,2.2fr)_minmax(0,1fr)_52px_136px_168px]'

/** `touch`: phone rows (40px targets, 插播 shown from 320px wide). */
export function SongActions({ song, compact, touch }: { song: Song; compact?: boolean; touch?: boolean }) {
  const h = touch ? 'h-10' : 'h-9'
  const statusOf = useStatusOf()
  const enqueue = useEnqueue()
  const st = statusOf(song)
  const addPending = useIsPending(enqueueKey(song.id, 'end'))
  const nextPending = useIsPending(enqueueKey(song.id, 'next'))
  if (st.isCurrent)
    return (
      <span className={clsx('inline-flex shrink-0 items-center gap-2 rounded-[10px] bg-[rgba(255,77,126,0.12)] px-3.5 text-sm font-semibold whitespace-nowrap text-accent-soft', h)}>
        <Eq />
        演唱中
      </span>
    )
  if (st.inQueue)
    return (
      <div className={clsx('flex shrink-0 items-center', touch ? 'gap-2' : 'gap-1.5')}>
        <PreviewButton song={song} size={touch ? 40 : undefined} />
        <span className={clsx('inline-flex items-center rounded-[10px] bg-white/6 px-3.5 text-sm whitespace-nowrap text-muted', h)}>已点</span>
      </div>
    )
  if (st.kind === 'vip')
    return (
      <div className={clsx('flex shrink-0 items-center', touch ? 'gap-2' : 'gap-1.5')}>
      <PreviewButton song={song} size={touch ? 40 : undefined} />
      <button
        type="button"
        disabled
        className={clsx('shrink-0 rounded-[10px] border border-white/10 px-3.5 text-sm whitespace-nowrap text-subtle', h)}
        title="这首歌需要会员，账号没有权限播放完整版"
      >
        不可点
      </button>
      </div>
    )
  return (
    <div className={clsx('flex shrink-0 items-center', touch ? 'gap-2' : 'gap-1.5')}>
      <PreviewButton song={song} size={touch ? 40 : undefined} />
      <IconButton
        icon="top"
        label={`插播 ${song.name}`}
        disabled={nextPending}
        onClick={() => enqueue(song, 'next')}
        size={touch ? 40 : undefined}
        className={clsx('bg-white/6 text-fg-2', touch ? 'hidden @xs:inline-flex' : compact && 'hidden @md:inline-flex')}
      />
      <button
        type="button"
        onClick={() => enqueue(song, 'end')}
        disabled={addPending}
        className={clsx(
          'flex shrink-0 items-center gap-1.5 rounded-[10px] bg-accent text-sm font-bold whitespace-nowrap text-accent-ink transition-transform hover:brightness-110 active:scale-95 disabled:opacity-70',
          touch ? 'h-10 px-3.5' : 'h-9 px-4',
        )}
      >
        {addPending && <Spinner size={14} />}
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
                  <ArtistLinks song={song} />
                </div>
                <span className="@2xl:hidden">
                  {st.kind !== 'new' && <StatusPill status={st} />}
                </span>
              </div>
            </div>
            <span className="hidden min-w-0 truncate text-sm text-muted @4xl:block">
              <AlbumLink song={song} />
            </span>
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

const linkCls = 'cursor-pointer hover:text-fg hover:underline underline-offset-2 decoration-white/30'

/** Artist names; each opens that artist's page on the desk. */
export function ArtistLinks({ song }: { song: Song }) {
  const nav = useDeskNav()
  if (!nav || !song.artists.some((a) => a.id)) return <span className="truncate">{artistsText(song)}</span>
  return (
    <span className="truncate">
      {song.artists.map((a, i) => (
        <span key={a.id || i}>
          {i > 0 && ' / '}
          {a.id ? (
            <button type="button" onClick={() => nav.openArtist(a.id, a.name)} className={linkCls} title={`查看歌手：${a.name}`}>
              {a.name}
            </button>
          ) : (
            a.name
          )}
        </span>
      ))}
    </span>
  )
}

/** Album name; opens the album page on the desk. */
export function AlbumLink({ song }: { song: Song }) {
  const nav = useDeskNav()
  if (!nav || !song.album.id) return <>{song.album.name}</>
  return (
    <button
      type="button"
      onClick={() => nav.openAlbum(song.album.id, song.album.name)}
      className={clsx(linkCls, 'max-w-full truncate text-left')}
      title={`查看专辑：${song.album.name}`}
    >
      {song.album.name}
    </button>
  )
}

export function RecCard({ song }: { song: Song }) {
  const enqueue = useEnqueue()
  const statusOf = useStatusOf()
  const st = statusOf(song)
  const disabled = st.kind === 'vip' || st.inQueue || st.isCurrent
  const nextPending = useIsPending(enqueueKey(song.id, 'next'))
  const addPending = useIsPending(enqueueKey(song.id, 'end'))
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
        {disabled && !st.isCurrent && (
          <div className={clsx('absolute bottom-2.5 left-2.5', reveal)}>
            <PreviewButton song={song} variant="overlay" />
          </div>
        )}
        {(st.inQueue || st.isCurrent) && (
          <span className="absolute right-2.5 bottom-2.5 inline-flex h-7 items-center gap-1.5 rounded-full bg-ink/70 px-2.5 text-xs text-fg-2">
            {st.isCurrent ? <Eq /> : <Icon name="check" size={13} />}
            {st.isCurrent ? '演唱中' : '已点'}
          </span>
        )}
        {!disabled && (
          <div className={clsx('absolute right-2.5 bottom-2.5 flex items-center gap-1.5', reveal)}>
            <PreviewButton song={song} variant="overlay" />
            <button
              type="button"
              onClick={() => enqueue(song, 'next')}
              disabled={nextPending}
              aria-label={`插播 ${song.name}`}
              title="插播"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-ink/70 text-fg shadow-[0_8px_20px_rgba(0,0,0,0.4)] backdrop-blur hover:bg-ink/85"
            >
              <Icon name="top" size={16} />
            </button>
            <button
              type="button"
              onClick={() => enqueue(song)}
              disabled={addPending}
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
