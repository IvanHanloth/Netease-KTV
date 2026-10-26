import { useEffect, useMemo, useRef, useState } from 'react'
import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query'
import clsx from 'clsx'
import { Link } from 'react-router'
import type { PlayerCommand, Song } from '@shared/types'
import { KEY_MAX, KEY_MIN, singerName } from '@shared/constants'
import { api } from '../lib/api'
import { artistsText, fmtMs, fmtTime } from '../lib/format'
import { errorText, toast, useDebounced, useHistory, useLiveValue, useSettings, useStatusOf } from '../lib/hooks'
import { stopPreview } from '../lib/preview'
import { connect, livePosition, sendCommand, useApp } from '../store/app'
import { Icon, type IconName } from '../components/icons'
import { MicControls } from '../components/MicControls'
import { Cover, Dialog, EmptyNote, Eq, IconButton, ProgressBar, QueryError, Range, Spinner, StatusPill } from '../components/ui'
import { Leaderboard } from '../components/Leaderboard'
import { NICKNAME_MAX, useNickname } from '../lib/nickname'
import { DisplayModeToggle, TrackModeToggle } from '../components/PlayerModes'
import { IdleVolumeControl } from '../components/IdleVolume'
import { SongActions } from '../components/SongTable'
import { NowSingingCard, QueueList, ShuffleButton, useNow } from '../components/QueuePanel'
import { ImportedPlaylistChips, ImportPlaylistDialog } from '../components/ImportPlaylist'
import { removeImportedPlaylist, useImportedPlaylists, type ImportedPlaylist } from '../lib/importedPlaylists'

type Tab = 'remote' | 'search' | 'queue' | 'rank'

/** A command from this phone; says so when it could not be sent (nothing is replayed later). */
function command(c: PlayerCommand) {
  if (!sendCommand(c)) toast('连接中断，这次操作没有发出', 'error')
}

function RoundButton({
  icon,
  label,
  onClick,
  primary,
}: {
  icon: IconName
  label: string
  onClick: () => void
  primary?: boolean
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className={clsx(
        'flex items-center justify-center rounded-full transition-transform active:scale-95',
        primary
          ? 'h-16 w-16 bg-accent text-accent-ink shadow-[0_10px_28px_rgba(255,77,126,0.45)]'
          : 'h-12 w-12 bg-white/8 text-fg active:bg-white/14',
      )}
    >
      <Icon name={icon} size={primary ? 26 : 20} strokeWidth={1.9} />
    </button>
  )
}

function RemoteTab({ onPickSong, onShowQueue }: { onPickSong: () => void; onShowQueue: () => void }) {
  const player = useApp((s) => s.state.player)
  const tvOnline = useApp((s) => s.state.tvOnline)
  const track = useApp((s) => (player.current ? s.state.tracks[player.current.song.id] : undefined))
  const queue = useApp((s) => s.state.queue)
  const statusOf = useStatusOf()
  const now = useNow(1000)
  const cur = player.current
  const dur = cur ? cur.song.duration / 1000 : 0
  // Never shown past the end, whatever the server's line says.
  const pos = Math.min(livePosition(player, now), dur > 0 ? dur : Infinity)
  const hasStems = !!track?.hasStems
  const [music, setMusic] = useLiveValue(Math.round(player.musicVolume * 100), (v) => ({ action: 'set', musicVolume: v / 100 }), command)
  const idleOn = useSettings().data?.idleEnabled ?? false
  const setKey = (k: number) => command({ action: 'set', key: Math.max(KEY_MIN, Math.min(KEY_MAX, k)) })
  const volLabel = hasStems && player.trackMode === 'karaoke' ? '伴奏音量' : '音量'

  return (
    <div className="flex flex-col gap-3.5">
      {!tvOnline && (
        <div className="flex items-center gap-2 rounded-2xl border border-[rgba(251,191,36,0.25)] bg-[rgba(251,191,36,0.08)] px-4 py-3 text-[13px] text-warn">
          <Icon name="tv" size={16} />
          大屏未打开：在电视或电脑浏览器打开 /tv 并点击开始
        </div>
      )}
      <section
        aria-label="正在演唱"
        className="rounded-3xl border border-white/10 bg-[linear-gradient(135deg,rgba(255,77,126,0.2)_0%,rgba(123,47,247,0.16)_100%)] p-4"
      >
        {cur ? (
          <>
            <div className="flex items-center gap-3.5">
              <Cover song={cur.song} px={160} className="h-16 w-16 rounded-2xl shadow-[0_10px_24px_rgba(0,0,0,0.35)]" />
              <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
                <span className="flex items-center gap-2 text-xs tracking-[0.12em] text-[#FFC2D1]">
                  {player.playing && <Eq color="#FFC2D1" />}
                  {player.playing ? '正在演唱' : '已暂停'}
                </span>
                <span className="truncate text-lg font-bold">{cur.song.name}</span>
                <span className="truncate text-[13px] text-fg-2">
                  {artistsText(cur.song)}
                  {hasStems ? ' · 伴奏保留和声' : track?.status === 'ready' ? ' · 原曲' : ''}
                </span>
              </div>
            </div>
            {track && track.status !== 'ready' ? (
              <div className="mt-3.5 flex items-center gap-2.5 text-xs text-fg-2">
                <StatusPill status={statusOf(cur.song)} />
              </div>
            ) : (
              <div className="num mt-3.5 flex items-center gap-2.5 text-xs text-fg-2">
                <span>{fmtTime(pos)}</span>
                <ProgressBar value={dur ? pos / dur : 0} color="#FFFFFF" className="flex-1 bg-white/18" />
                <span>{fmtTime(dur)}</span>
              </div>
            )}
            <div className="mt-3 flex items-center justify-center gap-7">
              <RoundButton icon="replay" label="重唱" onClick={() => command({ action: 'restart' })} />
              <RoundButton
                icon={player.playing ? 'pause' : 'play'}
                label={player.playing ? '暂停' : '播放'}
                primary
                onClick={() => command({ action: 'toggle' })}
              />
              <RoundButton icon="next" label="切歌" onClick={() => command({ action: 'next' })} />
            </div>
          </>
        ) : (
          <div className="flex flex-col items-center gap-3 py-3 text-sm text-fg-2">
            还没有在唱的歌
            <button type="button" onClick={onPickSong} className="h-11 rounded-full bg-accent px-6 font-semibold text-accent-ink">
              去点歌
            </button>
          </div>
        )}
      </section>

      <Link
        to="/ear"
        className="flex items-center gap-3.5 rounded-3xl border border-white/8 bg-white/4 p-4 active:bg-white/8"
      >
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-[linear-gradient(135deg,#FF4D7E_0%,#8B5CF6_100%)] text-white">
          <Icon name="headphones" size={22} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-[15px] font-semibold">移动耳返</span>
          <span className="truncate text-xs text-muted">在手机上听人声或原唱，同时当提词器</span>
        </span>
        <Icon name="chevronLeft" size={18} className="rotate-180 text-muted" />
      </Link>

      <section aria-label="调音" className="flex flex-col gap-3.5 rounded-3xl border border-white/8 bg-white/4 p-4">
        {cur && (
          <div className="flex flex-col gap-2">
            <TrackModeToggle stretch />
            <DisplayModeToggle stretch />
          </div>
        )}
        {!cur && idleOn && <IdleVolumeControl send={command} />}
        <label className="flex flex-col gap-1.5">
          <span className="flex items-center justify-between text-sm">
            <span className="flex items-center gap-2">
              <Icon name="volume" size={18} />
              {volLabel}
            </span>
            <span className="num text-[#C8C8D0]">{music}%</span>
          </span>
          <Range label={volLabel} value={music} onChange={setMusic} />
        </label>
        <div className="border-t border-white/8 pt-3.5">
          <MicControls send={command} />
        </div>
        <div className="flex items-center justify-between">
          <span className="text-sm">升降调</span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              aria-label="降调"
              onClick={() => setKey(player.key - 1)}
              disabled={player.key <= KEY_MIN}
              className="flex h-11 w-11 items-center justify-center rounded-[14px] bg-white/8 active:bg-white/14 disabled:opacity-40"
            >
              <Icon name="minus" size={18} strokeWidth={2.2} />
            </button>
            <span aria-live="polite" className="num w-12 text-center text-xl font-semibold text-accent">
              {player.key > 0 ? '+' + player.key : player.key}
            </span>
            <button
              type="button"
              aria-label="升调"
              onClick={() => setKey(player.key + 1)}
              disabled={player.key >= KEY_MAX}
              className="flex h-11 w-11 items-center justify-center rounded-[14px] bg-white/8 active:bg-white/14 disabled:opacity-40"
            >
              <Icon name="plus" size={18} strokeWidth={2.2} />
            </button>
            <button
              type="button"
              onClick={() => setKey(0)}
              className="h-11 rounded-[14px] border border-white/12 px-3 text-[13px] text-[#C8C8D0]"
            >
              原调
            </button>
          </div>
        </div>
      </section>

      <section aria-label="接下来" className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between px-0.5">
          <h2 className="m-0 text-[15px] font-semibold">接下来</h2>
          {queue.length > 0 && (
            <button type="button" onClick={onShowQueue} className="-my-2 -mr-2 flex h-10 items-center gap-0.5 px-2 text-[13px] text-muted active:text-fg">
              全部 {queue.length} 首
              <Icon name="chevronLeft" size={14} className="rotate-180" />
            </button>
          )}
        </div>
        {queue.length === 0 ? (
          <p className="m-0 py-4 text-center text-[13px] text-muted">{cur ? '这首唱完就没有了，去点歌吧' : '还没有点歌'}</p>
        ) : (
          queue.slice(0, 3).map((q) => {
            const st = statusOf(q.song)
            return (
              <div key={q.uid} className="flex items-center gap-3 px-1 py-2">
                <Cover song={q.song} px={100} className="h-[42px] w-[42px] rounded-[10px]" />
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="truncate text-sm font-semibold">{q.song.name}</span>
                  {st.kind === 'proc' || st.kind === 'download' ? (
                    <div className="flex items-center gap-2 text-xs text-warn">
                      <ProgressBar value={st.progress ?? 0} className="w-24" />
                      {st.label}
                    </div>
                  ) : (
                    <span className="truncate text-xs text-muted">
                      {artistsText(q.song)} · {st.label}
                      {singerName(q.addedBy) && <span className="text-[#FFC2D1]"> · {q.addedBy}</span>}
                    </span>
                  )}
                </div>
                <span className="num text-[13px] text-subtle">{fmtMs(q.song.duration)}</span>
              </div>
            )
          })
        )}
      </section>
    </div>
  )
}

function SongList({ songs }: { songs: Song[] }) {
  return (
    <div className="@container flex flex-col">
      {songs.map((s, i) => (
        <div key={s.id + '-' + i} className="flex items-center gap-3 py-2">
          <Cover song={s} px={100} className="h-12 w-12 rounded-xl" />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate text-[15px] font-semibold">{s.name}</span>
            <span className="flex items-center gap-1.5 truncate text-xs text-muted">
              {s.mvId > 0 && <span className="num rounded border border-white/25 px-1 text-[10px] font-bold text-fg-2">MV</span>}
              {artistsText(s)}
            </span>
          </div>
          <SongActions song={s} touch />
        </div>
      ))}
    </div>
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
      <label className="flex h-12 items-center gap-2.5 rounded-2xl border border-white/8 bg-white/6 px-4 focus-within:border-white/20">
        <Icon name="search" size={18} className="text-muted" />
        <span className="sr-only-x">搜索</span>
        <input
          type="search"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="搜索歌曲、歌手"
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
          <div className="flex flex-col gap-2">
            <h2 className="m-0 px-0.5 text-[15px] font-semibold">临时歌单</h2>
            <ImportedPlaylistChips onOpen={setOpenPl} onImport={() => setImportOpen(true)} />
          </div>
          <div role="tablist" aria-label="歌曲列表" className="flex items-center gap-2 px-0.5">
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
                  'h-10 rounded-full px-4 text-[15px] transition-colors',
                  list === k ? 'bg-white/10 font-semibold text-fg' : 'text-muted',
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
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-[260px] -left-[120px] h-[560px] w-[560px] rounded-full opacity-[0.32] blur-[16px]"
        style={{ background: 'radial-gradient(circle, #FF4D7E 0%, rgba(0,0,0,0) 62%)' }}
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute top-[120px] -right-[200px] h-[420px] w-[420px] rounded-full opacity-[0.22] blur-[16px]"
        style={{ background: 'radial-gradient(circle, #6D4BFF 0%, rgba(0,0,0,0) 60%)' }}
      />
      <header className="relative flex items-center justify-between px-5 pt-[max(22px,env(safe-area-inset-top))] pb-3.5">
        <div className="flex flex-col gap-1">
          <h1 className="m-0 text-[22px] font-bold">Netease KTV</h1>
          <span className="flex items-center gap-1.5 text-[13px] text-muted">
            <span
              aria-hidden="true"
              className="h-[7px] w-[7px] rounded-full"
              style={{ background: connected ? '#4ADE80' : '#FBBF24', boxShadow: connected ? '0 0 8px #4ADE80' : undefined }}
            />
            {connected ? `已连接 · ${location.host}` : '正在连接…'}
          </span>
        </div>
        <NicknameChip />
      </header>
      {showBanner && (
        <div
          role="status"
          className="relative mx-5 mb-2 flex items-center gap-2 rounded-2xl border border-[rgba(251,191,36,0.25)] bg-[rgba(251,191,36,0.1)] px-3.5 py-2.5 text-[13px] text-warn"
        >
          <Spinner size={14} />
          连接中断，正在重连…
        </div>
      )}

      <main ref={mainRef} className="relative min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        {tab === 'remote' && <RemoteTab onPickSong={() => switchTab('search')} onShowQueue={() => switchTab('queue')} />}
        {tab === 'search' && <SearchTab search={search} setSearch={setSearch} />}
        {tab === 'queue' && (
          <div className="flex flex-col gap-3">
            {current && <NowSingingCard />}
            <div className="flex items-center justify-between">
              <h2 className="m-0 px-0.5 text-[15px] font-semibold">接下来</h2>
              <ShuffleButton count={queue.length} className="-mr-2" />
            </div>
            <QueueList />
          </div>
        )}
        {tab === 'rank' && (
          <div className="flex flex-col gap-3">
            <h2 className="m-0 px-0.5 text-[15px] font-semibold">K 歌排行</h2>
            <Leaderboard />
          </div>
        )}
      </main>

      <nav
        aria-label="底部导航"
        className="relative grid h-[calc(64px+env(safe-area-inset-bottom))] shrink-0 grid-cols-4 border-t border-white/8 bg-ink/85 px-3 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl"
      >
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => switchTab(t.id)}
            aria-current={tab === t.id ? 'page' : undefined}
            className={clsx(
              'flex flex-col items-center justify-center gap-1 text-xs whitespace-nowrap',
              tab === t.id ? 'font-semibold text-accent' : 'text-muted',
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
        className="flex h-10 max-w-[45%] shrink-0 items-center gap-1.5 rounded-full border border-white/10 bg-white/6 px-3.5 text-[13px] whitespace-nowrap text-fg-2"
        aria-label={nickname ? `昵称：${nickname}，点击修改` : '设置昵称'}
      >
        <Icon name={nickname ? 'user' : 'pen'} size={15} />
        <span className="truncate">{nickname || '设置昵称'}</span>
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
