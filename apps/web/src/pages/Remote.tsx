import { useEffect, useMemo, useRef, useState } from 'react'
import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { AnimatePresence, motion } from 'motion/react'
import clsx from 'clsx'
import { Link } from 'react-router'
import type { PlayerCommand, QueueItem, Song } from '@shared/types'
import { KEY_MAX, KEY_MIN } from '@shared/constants'
import { api } from '../lib/api'
import { artistsText, fmtTime, queueStatusText } from '../lib/format'
import {
  errorText,
  runAction,
  shuffleQueue,
  toast,
  useDebounced,
  useHistory,
  useIsPending,
  useLiveValue,
  useSettings,
  useStatusOf,
} from '../lib/hooks'
import { useDragReorder } from '../lib/useDragReorder'
import { stopPreview } from '../lib/preview'
import { connect, livePosition, sendCommand, useApp } from '../store/app'
import { Icon, type IconName } from '../components/icons'
import { MicControls } from '../components/MicControls'
import { Cover, Dialog, dotColor, EmptyNote, IconButton, ProgressBar, QueryError, Range, Spinner, StatusPill } from '../components/ui'
import { Leaderboard } from '../components/Leaderboard'
import { NICKNAME_MAX, useNickname } from '../lib/nickname'
import { DisplayModeToggle, TrackModeToggle } from '../components/PlayerModes'
import { IdleVolumeControl } from '../components/IdleVolume'
import { SongActions } from '../components/SongTable'
import { ImportedPlaylistChips, ImportPlaylistDialog } from '../components/ImportPlaylist'
import { removeImportedPlaylist, useImportedPlaylists, type ImportedPlaylist } from '../lib/importedPlaylists'

type Tab = 'remote' | 'search' | 'queue' | 'rank'

/** A command from this phone; says so when it could not be sent (nothing is replayed later). */
function command(c: PlayerCommand) {
  if (!sendCommand(c)) toast('连接中断，这次操作没有发出', 'error')
}

function useTick(interval = 1000) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), interval)
    return () => clearInterval(t)
  }, [interval])
  return now
}

const keyLabel = (k: number) => (k > 0 ? '+' + k : String(k))

function RemoteTab({ onPickSong }: { onPickSong: () => void }) {
  const player = useApp((s) => s.state.player)
  const tvOnline = useApp((s) => s.state.tvOnline)
  const track = useApp((s) => (player.current ? s.state.tracks[player.current.song.id] : undefined))
  const statusOf = useStatusOf()
  const now = useTick(1000)
  const cur = player.current
  const dur = cur ? cur.song.duration / 1000 : 0
  // Never shown past the end, whatever the server's line says.
  const pos = Math.min(livePosition(player, now), dur > 0 ? dur : Infinity)
  const hasStems = !!track?.hasStems
  const [music, setMusic] = useLiveValue(Math.round(player.musicVolume * 100), (v) => ({ action: 'set', musicVolume: v / 100 }), command)
  const idleOn = useSettings().data?.idleEnabled ?? false
  const volLabel = hasStems && player.trackMode === 'karaoke' ? '伴奏音量' : '音量'
  const [keyOpen, setKeyOpen] = useState(false)

  return (
    <div className="flex flex-col gap-6 pb-2">
      <div className="flex justify-end">
        <NicknameChip />
      </div>
      {!tvOnline && (
        <div className="-mt-2 flex items-center gap-2 rounded-2xl bg-[rgba(251,191,36,0.08)] px-4 py-3 text-[13px] text-warn">
          <Icon name="tv" size={16} />
          大屏未打开：在电视或电脑浏览器打开 /tv 并点击开始
        </div>
      )}

      {cur ? (
        <section aria-label="正在演唱" className="flex flex-col items-center px-3 text-center">
          <Cover song={cur.song} px={480} className="h-44 w-44 rounded-[28px]" />
          <span className="mt-5 max-w-full truncate text-2xl font-extrabold">{cur.song.name}</span>
          <span className="mt-1.5 max-w-full truncate text-sm text-muted">
            {artistsText(cur.song)}
            {cur.addedBy && ` · ${cur.addedBy}在唱`}
          </span>
          {track && track.status !== 'ready' ? (
            <div className="mt-5 flex items-center gap-2.5 text-xs text-fg-2">
              <StatusPill status={statusOf(cur.song)} />
            </div>
          ) : (
            <div className="num mt-5 flex w-full items-center gap-2.5 text-xs text-subtle">
              <span>{fmtTime(pos)}</span>
              <ProgressBar value={dur ? pos / dur : 0} color="#FF4D7E" className="flex-1 bg-white/10" />
              <span>{fmtTime(dur)}</span>
            </div>
          )}
          <div className="mt-5 flex items-center justify-center gap-12">
            <TransportButton icon="replay" label="重唱" onClick={() => command({ action: 'restart' })} />
            <button
              type="button"
              aria-label={player.playing ? '暂停' : '播放'}
              onClick={() => command({ action: 'toggle' })}
              className="flex h-[72px] w-[72px] items-center justify-center rounded-full bg-accent text-accent-ink transition-transform active:scale-95"
            >
              <Icon name={player.playing ? 'pause' : 'play'} size={28} />
            </button>
            <TransportButton icon="next" label="切歌" onClick={() => command({ action: 'next' })} />
          </div>
        </section>
      ) : (
        <div className="flex flex-col items-center gap-3 py-10 text-sm text-fg-2">
          还没有在唱的歌
          <button type="button" onClick={onPickSong} className="h-11 rounded-full bg-accent px-6 font-semibold text-accent-ink">
            去点歌
          </button>
        </div>
      )}

      <section aria-label="调节" className="flex flex-col gap-5">
        {cur && (
          <div className="flex flex-col gap-2">
            <TrackModeToggle stretch />
            <DisplayModeToggle stretch />
          </div>
        )}
        {!cur && idleOn && <IdleVolumeControl send={command} />}
        <div className="flex items-center gap-3.5 px-1">
          <Icon name="volume" size={20} className="shrink-0 text-muted" />
          <div className="min-w-0 flex-1">
            <Range label={volLabel} value={music} onChange={setMusic} />
          </div>
          <span className="num w-10 shrink-0 text-right text-[13px] text-muted">{music}%</span>
        </div>
        <MicControls send={command} />
        <div className="grid grid-cols-2 gap-2.5">
          <button
            type="button"
            onClick={() => setKeyOpen(true)}
            aria-haspopup="dialog"
            className="flex h-12 items-center justify-between rounded-[14px] bg-white/4 px-4 text-sm text-muted active:bg-white/8"
          >
            升降调
            <span className="num text-[15px] font-bold text-fg">{player.key === 0 ? '原调' : keyLabel(player.key)}</span>
          </button>
          <Link
            to="/ear"
            className="flex h-12 items-center justify-center gap-2 rounded-[14px] bg-white/4 text-sm font-semibold text-fg active:bg-white/8"
          >
            <Icon name="headphones" size={18} />
            移动耳返
          </Link>
        </div>
      </section>
      <KeySheet open={keyOpen} onClose={() => setKeyOpen(false)} value={player.key} />
    </div>
  )
}

function TransportButton({ icon, label, onClick }: { icon: IconName; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="flex h-12 w-12 items-center justify-center rounded-full text-fg-2 transition-transform active:scale-95 active:bg-white/8"
    >
      <Icon name={icon} size={24} strokeWidth={1.9} />
    </button>
  )
}

/** 升降调 fine control, opened from the cell on the 遥控 tab. */
function KeySheet({ open, onClose, value }: { open: boolean; onClose: () => void; value: number }) {
  const setKey = (k: number) => command({ action: 'set', key: Math.max(KEY_MIN, Math.min(KEY_MAX, k)) })
  return (
    <Dialog open={open} onClose={onClose} title="升降调" width={380} sheet>
      <div className="flex flex-col items-center gap-5 pb-2">
        <div className="flex items-center gap-6">
          <button
            type="button"
            aria-label="降调"
            onClick={() => setKey(value - 1)}
            disabled={value <= KEY_MIN}
            className="flex h-14 w-14 items-center justify-center rounded-2xl bg-white/8 active:bg-white/14 disabled:opacity-40"
          >
            <Icon name="minus" size={22} strokeWidth={2.2} />
          </button>
          <span aria-live="polite" className="num w-16 text-center text-3xl font-bold text-accent">
            {keyLabel(value)}
          </span>
          <button
            type="button"
            aria-label="升调"
            onClick={() => setKey(value + 1)}
            disabled={value >= KEY_MAX}
            className="flex h-14 w-14 items-center justify-center rounded-2xl bg-white/8 active:bg-white/14 disabled:opacity-40"
          >
            <Icon name="plus" size={22} strokeWidth={2.2} />
          </button>
        </div>
        <button
          type="button"
          onClick={() => setKey(0)}
          disabled={value === 0}
          className="h-11 rounded-xl px-5 text-sm text-fg-2 active:bg-white/8 disabled:opacity-40"
        >
          回到原调
        </button>
      </div>
    </Dialog>
  )
}

// ---------- 已点 ----------

const safe = (key: string, fn: () => Promise<unknown>) => runAction(key, fn)

/** 正在演唱 on the 已点 tab. */
function NowCard() {
  const player = useApp((s) => s.state.player)
  const now = useTick(1000)
  const cur = player.current
  if (!cur)
    return (
      <div className="rounded-[22px] border border-dashed border-white/12 p-5 text-center text-sm text-muted">还没有在唱的歌，点一首开始吧</div>
    )
  const dur = cur.song.duration / 1000
  const pos = Math.min(livePosition(player, now), dur > 0 ? dur : Infinity)
  return (
    <section aria-label="正在演唱" className="flex items-center gap-3 rounded-[22px] border border-[rgba(255,77,126,0.22)] bg-[#1A1622] p-3.5">
      <Cover song={cur.song} px={160} className="h-[54px] w-[54px] shrink-0 rounded-[14px]" />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-xs tracking-[0.1em] text-[#FF8FAB]">
          {player.playing ? '正在演唱' : '已暂停'}
          {cur.addedBy && ` · ${cur.addedBy}`}
        </span>
        <span className="truncate text-[17px] font-extrabold">{cur.song.name}</span>
        <span className="num text-xs text-muted">
          {fmtTime(pos)} / {fmtTime(dur)}
        </span>
      </span>
      <button
        type="button"
        aria-label={player.playing ? '暂停' : '播放'}
        onClick={() => command({ action: 'toggle' })}
        className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-accent text-accent-ink active:scale-95"
      >
        <Icon name={player.playing ? 'pause' : 'play'} size={20} />
      </button>
    </section>
  )
}

type HandleProps = ReturnType<ReturnType<typeof useDragReorder<QueueItem>>['handleProps']>

function QueueRow({
  item,
  index,
  dragging,
  rowRef,
  handle,
}: {
  item: QueueItem
  index: number
  dragging: boolean
  rowRef: (el: HTMLElement | null) => void
  handle: HandleProps
}) {
  const statusOf = useStatusOf()
  const st = statusOf(item.song)
  const busy = st.kind === 'proc' || st.kind === 'download'
  return (
    <motion.li
      ref={rowRef}
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0, scale: dragging ? 1.03 : 1 }}
      exit={{ opacity: 0, x: 24 }}
      transition={{ duration: 0.2 }}
      className={clsx(
        'relative flex items-center gap-2.5 rounded-[18px] border py-2.5 pr-1.5 pl-1',
        dragging ? 'z-10 border-white/22 bg-[#22222E] shadow-[0_16px_36px_rgba(0,0,0,0.55)]' : 'border-white/6 bg-[#14141C]',
      )}
    >
      <button
        type="button"
        {...handle}
        aria-label={`拖动排序 ${item.song.name}（方向键上下移动）`}
        className={clsx(
          'flex h-11 w-7 shrink-0 touch-none items-center justify-center rounded-lg text-faint',
          dragging && 'text-fg',
        )}
      >
        <Icon name="grip" size={18} />
      </button>
      <Cover song={item.song} px={100} className="h-[46px] w-[46px] shrink-0 rounded-xl" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="truncate text-[15px] font-semibold">{item.song.name}</span>
        <span className="truncate text-xs text-muted">
          <span style={{ color: st.kind === 'error' ? '#FF8FAB' : busy ? '#FCD34D' : dotColor[st.kind] }}>{queueStatusText(st)}</span>
          {item.addedBy && ` · ${item.addedBy}`}
        </span>
        {busy && <ProgressBar value={st.progress ?? 0} className="w-full" />}
      </div>
      {st.kind === 'error' && (
        <button
          type="button"
          onClick={() => safe(`track:retry:${item.song.id}`, () => api.retryTrack(item.song.id))}
          className="h-11 shrink-0 rounded-xl border border-[rgba(255,143,171,0.4)] px-3 text-[13px] text-[#FF8FAB]"
        >
          重试
        </button>
      )}
      <IconButton
        icon="top"
        label={`置顶 ${item.song.name}`}
        size={44}
        iconSize={18}
        disabled={index === 0}
        onClick={() => safe(`queue:top:${item.uid}`, () => api.queueTop(item.uid))}
      />
      <IconButton
        icon="x"
        label={`删除 ${item.song.name}`}
        size={44}
        iconSize={18}
        onClick={() => safe(`queue:remove:${item.uid}`, () => api.queueRemove(item.uid))}
      />
    </motion.li>
  )
}

const queueKey = (q: QueueItem) => q.uid
const commitOrder = (uids: string[]) => api.queueReorder(uids)
const reorderFailed = (e: unknown) => toast(`排序失败：${errorText(e)}`, 'error')

function QueueList() {
  const queue = useApp((s) => s.state.queue)
  const { ordered, dragKey, rowRef, handleProps } = useDragReorder(queue, queueKey, commitOrder, reorderFailed)
  if (!queue.length) return <EmptyNote>后面还没有歌，去点歌吧</EmptyNote>
  return (
    <ol aria-label="接下来" className={clsx('m-0 flex list-none flex-col gap-2 p-0', dragKey && 'select-none')}>
      <AnimatePresence initial={false}>
        {ordered.map((item, i) => (
          <QueueRow key={item.uid} item={item} index={i} dragging={dragKey === item.uid} rowRef={rowRef(item.uid)} handle={handleProps(item.uid)} />
        ))}
      </AnimatePresence>
    </ol>
  )
}

function QueueTab() {
  const queue = useApp((s) => s.state.queue)
  const current = useApp((s) => s.state.player.current)
  const shuffling = useIsPending('queue:shuffle')
  const count = queue.length + (current ? 1 : 0)
  return (
    <div className="flex flex-col gap-3.5">
      <h1 className="m-0 text-[26px] font-black">
        已点 {count > 0 && <span className="num text-[#FF8FAB]">{count}</span>}
      </h1>
      <NowCard />
      <div className="flex items-center justify-between px-0.5 pt-1">
        <h2 className="m-0 text-[13px] font-normal text-muted">接下来</h2>
        <button
          type="button"
          disabled={queue.length < 2 || shuffling}
          onClick={() => void shuffleQueue(queue.length)}
          className="-my-2 flex h-10 items-center gap-1.5 rounded-xl border border-white/12 px-3.5 text-sm text-fg-2 disabled:opacity-40"
        >
          <Icon name="shuffle" size={16} />
          随机
        </button>
      </div>
      <QueueList />
    </div>
  )
}

function SongList({ songs }: { songs: Song[] }) {
  const statusOf = useStatusOf()
  return (
    <ul className="@container m-0 flex list-none flex-col p-0">
      {songs.map((s, i) => {
        const st = statusOf(s)
        const busy = st.kind === 'proc' || st.kind === 'download'
        return (
          <li key={s.id + '-' + i} className={clsx('flex min-h-[66px] items-center gap-3 border-b border-white/5 py-2', st.kind === 'vip' && 'opacity-60')}>
            <Cover song={s} px={100} className="h-12 w-12 shrink-0 rounded-xl" />
            <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
              <span className="truncate text-[15px] font-semibold">{s.name}</span>
              <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted">
                {s.mvId > 0 && <span className="num shrink-0 rounded border border-white/25 px-1 text-[10px] font-bold text-fg-2">MV</span>}
                <span className="truncate">
                  {artistsText(s)}
                  {busy && <span className="text-warn"> · {st.label}</span>}
                </span>
              </span>
            </div>
            <SongActions song={s} touch />
          </li>
        )
      })}
    </ul>
  )
}

/** Tracks of a playlist imported on this device (phone 点歌 tab). */
function ImportedPlaylistTracks({ playlist, onBack }: { playlist: ImportedPlaylist; onBack: () => void }) {
  const tracks = useInfiniteQuery({
    queryKey: ['playlist', playlist.id],
    queryFn: ({ pageParam }) => api.playlistTracks(playlist.id, pageParam, 100),
    initialPageParam: 0,
    getNextPageParam: (last, pages) => (last.hasMore ? pages.reduce((n, p) => n + p.songs.length, 0) : undefined),
  })
  const songs = useMemo(() => tracks.data?.pages.flatMap((p) => p.songs) ?? [], [tracks.data])
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <IconButton icon="chevronLeft" label="返回" onClick={onBack} size={40} />
        <div className="flex min-w-0 flex-1 flex-col">
          <h2 className="m-0 truncate text-[16px] font-semibold">{playlist.name}</h2>
          <span className="truncate text-xs text-muted">临时歌单 · 仅保存在这台设备</span>
        </div>
        <button
          type="button"
          onClick={() => {
            removeImportedPlaylist(playlist.id)
            onBack()
          }}
          className="h-9 shrink-0 rounded-xl px-3 text-[13px] whitespace-nowrap text-muted hover:bg-white/6"
        >
          移除
        </button>
      </div>
      {tracks.isLoading ? (
        <div className="flex justify-center py-10 text-muted">
          <Spinner />
        </div>
      ) : tracks.isError && !songs.length ? (
        <QueryError compact error={new Error(errorText(tracks.error))} onRetry={() => tracks.refetch()} retrying={tracks.isFetching} />
      ) : songs.length ? (
        <>
          <SongList songs={songs} />
          {tracks.hasNextPage && (
            <button
              type="button"
              onClick={() => tracks.fetchNextPage()}
              disabled={tracks.isFetchingNextPage}
              className="h-11 rounded-xl bg-white/6 text-sm text-fg-2"
            >
              {tracks.isFetchingNextPage ? '加载中…' : tracks.isFetchNextPageError ? '加载失败，点击重试' : '加载更多'}
            </button>
          )}
        </>
      ) : (
        <EmptyNote>这个歌单是空的</EmptyNote>
      )}
    </div>
  )
}

/** 点歌记录 on the phone: same shared list as the desk. */
function HistoryList() {
  const q = useHistory()
  if (q.isLoading)
    return (
      <div className="flex justify-center py-10 text-muted">
        <Spinner />
      </div>
    )
  if (q.isError && !q.data)
    return <QueryError compact error={new Error(errorText(q.error))} onRetry={() => q.refetch()} retrying={q.isFetching} />
  const songs = q.data?.songs ?? []
  return songs.length ? <SongList songs={songs} /> : <EmptyNote>还没有点过歌</EmptyNote>
}

interface SearchState {
  value: string
  openPl: ImportedPlaylist | null
  list: 'rec' | 'history'
}

function SearchTab({ search, setSearch }: { search: SearchState; setSearch: (patch: Partial<SearchState>) => void }) {
  const { value, openPl, list } = search
  const setValue = (v: string) => setSearch({ value: v })
  const setOpenPl = (p: ImportedPlaylist | null) => setSearch({ openPl: p })
  const setList = (l: SearchState['list']) => setSearch({ list: l })
  const q = useDebounced(value.trim(), 350)
  const [importOpen, setImportOpen] = useState(false)
  // Close an opened playlist if it was removed (e.g. from another tab of this browser).
  const imported = useImportedPlaylists()
  useEffect(() => {
    if (openPl && !imported.some((p) => p.id === openPl.id)) setOpenPl(null)
  }, [imported, openPl]) // eslint-disable-line react-hooks/exhaustive-deps
  const results = useInfiniteQuery({
    queryKey: ['search', q],
    queryFn: ({ pageParam }) => api.search(q, pageParam, 30),
    initialPageParam: 0,
    getNextPageParam: (last, pages) => (last.hasMore ? pages.reduce((n, p) => n + p.songs.length, 0) : undefined),
    enabled: q.length > 0,
    placeholderData: keepPreviousData,
  })
  const rec = useQuery({ queryKey: ['recommend', 'm'], queryFn: api.recommend, enabled: q.length === 0 })
  const songs = useMemo(() => results.data?.pages.flatMap((p) => p.songs) ?? [], [results.data])
  return (
    <div className="flex flex-col gap-3">
      <label className="flex h-[50px] items-center gap-2.5 rounded-2xl border border-white/10 bg-[#17171F] px-3.5 focus-within:border-white/22">
        <Icon name="search" size={19} className="text-muted" />
        <span className="sr-only-x">搜索</span>
        <input
          type="search"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="搜索歌曲、歌手、一句歌词"
          enterKeyHint="search"
          className="h-full min-w-0 flex-1 border-0 bg-transparent text-base text-fg outline-none placeholder:text-subtle"
        />
      </label>
      {q ? (
        results.isLoading || (results.isPlaceholderData && !songs.length) ? (
          <div className="flex justify-center py-10 text-muted">
            <Spinner />
          </div>
        ) : results.isError && !songs.length ? (
          <QueryError
            compact
            error={new Error(errorText(results.error))}
            onRetry={() => results.refetch()}
            retrying={results.isFetching}
          />
        ) : songs.length ? (
          <>
            <div className={clsx('transition-opacity', results.isPlaceholderData && 'opacity-50')}>
              <SongList songs={songs} />
            </div>
            {results.hasNextPage && (
              <button
                type="button"
                onClick={() => results.fetchNextPage()}
                disabled={results.isFetchingNextPage}
                className="h-11 rounded-xl bg-white/6 text-sm text-fg-2"
              >
                {results.isFetchingNextPage ? '加载中…' : results.isFetchNextPageError ? '加载失败，点击重试' : '加载更多'}
              </button>
            )}
          </>
        ) : (
          <EmptyNote>没有找到相关歌曲</EmptyNote>
        )
      ) : openPl ? (
        <ImportedPlaylistTracks playlist={openPl} onBack={() => setOpenPl(null)} />
      ) : (
        <>
          <ImportedPlaylistChips onOpen={setOpenPl} onImport={() => setImportOpen(true)} />
          <div role="tablist" aria-label="歌曲列表" className="grid h-[42px] grid-cols-2 rounded-[14px] bg-white/5 p-1">
            {(
              [
                ['rec', rec.data?.daily ? '每日推荐' : '热门推荐'],
                ['history', '点歌记录'],
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                type="button"
                role="tab"
                aria-selected={list === k}
                onClick={() => setList(k)}
                className={clsx(
                  'rounded-[10px] text-sm transition-colors',
                  list === k ? 'bg-fg font-bold text-ink' : 'text-fg-2',
                )}
              >
                {label}
              </button>
            ))}
          </div>
          {list === 'history' ? (
            <HistoryList />
          ) : rec.isLoading ? (
            <div className="flex justify-center py-10 text-muted">
              <Spinner />
            </div>
          ) : rec.isError && !rec.data ? (
            <QueryError compact error={new Error(errorText(rec.error))} onRetry={() => rec.refetch()} retrying={rec.isFetching} />
          ) : (
            <SongList songs={rec.data?.songs ?? []} />
          )}
        </>
      )}
      <ImportPlaylistDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={(p) => {
          setValue('')
          setOpenPl({ ...p, importedAt: Date.now() })
        }}
      />
    </div>
  )
}

export default function Remote() {
  const [tab, setTab] = useState<Tab>('remote')
  const [search, setSearchState] = useState<SearchState>({ value: '', openPl: null, list: 'rec' })
  const setSearch = (patch: Partial<SearchState>) => setSearchState((s) => ({ ...s, ...patch }))
  // Each tab keeps its own scroll position.
  const mainRef = useRef<HTMLElement>(null)
  const scrolls = useRef<Partial<Record<Tab, number>>>({})
  const switchTab = (t: Tab) => {
    if (t === tab) return
    if (mainRef.current) scrolls.current[tab] = mainRef.current.scrollTop
    setTab(t)
  }
  useEffect(() => {
    mainRef.current?.scrollTo({ top: scrolls.current[tab] ?? 0 })
  }, [tab])
  const connected = useApp((s) => s.connected)
  const queue = useApp((s) => s.state.queue)
  const current = useApp((s) => s.state.player.current)
  const count = queue.length + (current ? 1 : 0)
  useEffect(() => connect('remote'), [])
  // 试听 only plays while the user is on the page / tab where it started.
  useEffect(() => stopPreview, [])
  useEffect(() => stopPreview(), [tab])
  // Reconnect banner: only after the first successful connection, and not for blips < 1.5 s.
  const everConnected = useRef(false)
  if (connected) everConnected.current = true
  const [showBanner, setShowBanner] = useState(false)
  useEffect(() => {
    if (connected || !everConnected.current) {
      setShowBanner(false)
      return
    }
    const t = window.setTimeout(() => setShowBanner(true), 1500)
    return () => window.clearTimeout(t)
  }, [connected])
  useEffect(() => {
    document.title = '手机遥控 · Netease KTV'
  }, [])
  const tabs: { id: Tab; label: string; icon: IconName }[] = [
    { id: 'remote', label: '遥控', icon: 'remote' },
    { id: 'search', label: '点歌', icon: 'note' },
    { id: 'queue', label: count ? `已点 ${count}` : '已点', icon: 'list' },
    { id: 'rank', label: '排行', icon: 'trophy' },
  ]
  return (
    <div className="relative mx-auto flex h-full max-w-[560px] flex-col overflow-hidden bg-ink text-fg">
      {showBanner && (
        <div
          role="status"
          className="absolute inset-x-5 top-[max(12px,env(safe-area-inset-top))] z-20 flex items-center gap-2 rounded-2xl bg-[#2A2414] px-3.5 py-2.5 text-[13px] text-warn"
        >
          <Spinner size={14} />
          连接中断，正在重连…
        </div>
      )}

      <main ref={mainRef} className="relative min-h-0 flex-1 overflow-y-auto px-5 pt-[max(20px,env(safe-area-inset-top))] pb-6">
        {tab === 'remote' && <RemoteTab onPickSong={() => switchTab('search')} />}
        {tab === 'search' && <SearchTab search={search} setSearch={setSearch} />}
        {tab === 'queue' && <QueueTab />}
        {tab === 'rank' && (
          <div className="flex flex-col gap-3">
            <h1 className="m-0 text-[26px] font-black">K 歌排行</h1>
            <Leaderboard />
          </div>
        )}
      </main>

      <nav
        aria-label="底部导航"
        className="relative grid h-[calc(64px+env(safe-area-inset-bottom))] shrink-0 grid-cols-4 bg-ink px-3 pb-[env(safe-area-inset-bottom)]"
      >
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => switchTab(t.id)}
            aria-current={tab === t.id ? 'page' : undefined}
            className={clsx(
              'flex flex-col items-center justify-center gap-1 text-xs whitespace-nowrap',
              tab === t.id ? 'font-bold text-accent' : 'text-subtle',
            )}
          >
            <Icon name={t.icon} size={22} />
            {t.label}
          </button>
        ))}
      </nav>
    </div>
  )
}

/** Header chip showing the singer nickname; asks for one the first time the remote opens. */
function NicknameChip() {
  const nickname = useNickname((s) => s.nickname)
  const asked = useNickname((s) => s.asked)
  const setNickname = useNickname((s) => s.setNickname)
  const markAsked = useNickname((s) => s.markAsked)
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState(nickname)

  useEffect(() => {
    if (!asked) setOpen(true)
  }, [asked])
  useEffect(() => {
    if (open) setValue(nickname)
  }, [open, nickname])

  const close = () => {
    markAsked()
    setOpen(false)
  }
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#23232E] text-[13px] font-bold text-fg"
        aria-label={nickname ? `昵称：${nickname}，点击修改` : '设置昵称'}
      >
        {nickname ? Array.from(nickname)[0] : <Icon name="pen" size={16} />}
      </button>
      <Dialog open={open} onClose={close} title="你的昵称" width={380}>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            setNickname(value)
            setOpen(false)
          }}
        >
          <p className="m-0 text-[13px] leading-6 text-muted">点歌时会显示这个名字，唱完的分数也会记在它名下。只保存在这台手机上。</p>
          <input
            autoFocus
            value={value}
            maxLength={NICKNAME_MAX}
            onChange={(e) => setValue(e.target.value)}
            placeholder="例如：小林"
            className="h-12 w-full rounded-xl border border-white/10 bg-white/5 px-3.5 text-base text-fg outline-none placeholder:text-faint focus:border-white/25"
          />
          <div className="flex justify-end gap-3">
            <button type="button" onClick={close} className="h-11 rounded-xl bg-white/8 px-5 text-sm whitespace-nowrap">
              跳过
            </button>
            <button type="submit" className="h-11 rounded-xl bg-accent px-5 text-sm font-bold whitespace-nowrap text-accent-ink">
              保存
            </button>
          </div>
        </form>
      </Dialog>
    </>
  )
}
