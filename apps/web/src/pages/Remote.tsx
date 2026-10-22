import { useEffect, useMemo, useRef, useState } from 'react'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import clsx from 'clsx'
import type { PlayerCommand, Song } from '@shared/types'
import { api } from '../lib/api'
import { artistsText, fmtMs, fmtTime } from '../lib/format'
import { playQueuedNow, useDebounced, useStatusOf } from '../lib/hooks'
import { connect, livePosition, sendCommand, useApp } from '../store/app'
import { Icon, type IconName } from '../components/icons'
import { Cover, EmptyNote, Eq, IconButton, ProgressBar, Range, Spinner, StatusPill } from '../components/ui'
import { DisplayModeToggle, TrackModeToggle } from '../components/PlayerModes'
import { SongActions } from '../components/SongTable'
import { QueueList, useNow } from '../components/QueuePanel'

type Tab = 'remote' | 'search' | 'queue'

/** Local slider state that streams throttled `set` commands. */
function useLiveValue(remote: number, toCommand: (v: number) => PlayerCommand) {
  const [local, setLocal] = useState<number | null>(null)
  const last = useRef(0)
  const timer = useRef<number | undefined>(undefined)
  const idle = useRef<number | undefined>(undefined)
  const change = (v: number) => {
    setLocal(v)
    const now = Date.now()
    clearTimeout(timer.current)
    if (now - last.current > 120) {
      last.current = now
      sendCommand(toCommand(v))
    } else {
      timer.current = window.setTimeout(() => {
        last.current = Date.now()
        sendCommand(toCommand(v))
      }, 120)
    }
    clearTimeout(idle.current)
    idle.current = window.setTimeout(() => setLocal(null), 800)
  }
  return [local ?? remote, change] as const
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

function RemoteTab() {
  const player = useApp((s) => s.state.player)
  const tvOnline = useApp((s) => s.state.tvOnline)
  const track = useApp((s) => (player.current ? s.state.tracks[player.current.song.id] : undefined))
  const queue = useApp((s) => s.state.queue)
  const statusOf = useStatusOf()
  const now = useNow(1000)
  const cur = player.current
  const pos = livePosition(player, now)
  const dur = cur ? cur.song.duration / 1000 : 0
  const hasStems = !!track?.hasStems
  const [music, setMusic] = useLiveValue(Math.round(player.musicVolume * 100), (v) => ({ action: 'set', musicVolume: v / 100 }))
  const [vocal, setVocal] = useLiveValue(Math.round(player.vocalVolume * 100), (v) => ({ action: 'set', vocalVolume: v / 100 }))
  const setKey = (k: number) => sendCommand({ action: 'set', key: Math.max(-6, Math.min(6, k)) })

  return (
    <div className="flex flex-col gap-3.5">
      {!tvOnline && (
        <div className="flex items-center gap-2 rounded-2xl border border-[rgba(251,191,36,0.25)] bg-[rgba(251,191,36,0.08)] px-4 py-3 text-[13px] text-warn">
          <Icon name="tv" size={16} />
          主屏未打开：在电视或电脑浏览器打开 /tv 并点击开始
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
          </>
        ) : (
          <div className="py-3 text-center text-sm text-fg-2">还没有在唱的歌，去“点歌”挑一首吧</div>
        )}
        <div className="mt-3 flex items-center justify-center gap-7">
          <RoundButton icon="replay" label="重唱" onClick={() => sendCommand({ action: 'restart' })} />
          <RoundButton
            icon={player.playing ? 'pause' : 'play'}
            label={player.playing ? '暂停' : '播放'}
            primary
            onClick={() => sendCommand({ action: 'toggle' })}
          />
          <RoundButton icon="next" label="切歌" onClick={() => sendCommand({ action: 'next' })} />
        </div>
      </section>

      <section aria-label="调音" className="flex flex-col gap-3.5 rounded-3xl border border-white/8 bg-white/4 p-4">
        {cur && (
          <div className="flex flex-col gap-2">
            <TrackModeToggle stretch />
            <DisplayModeToggle stretch />
          </div>
        )}
        <label className="flex flex-col gap-1.5">
          <span className="flex items-center justify-between text-sm">
            <span className="flex items-center gap-2">
              <Icon name="volume" size={18} />
              {hasStems && player.trackMode === 'karaoke' ? '伴奏音量' : '音量'}
            </span>
            <span className="num text-[#C8C8D0]">{music}%</span>
          </span>
          <Range label="伴奏音量" value={music} onChange={setMusic} />
        </label>
        {hasStems && player.trackMode === 'karaoke' && (
          <label className="flex flex-col gap-1.5">
            <span className="flex items-center justify-between text-sm">
              <span className="flex items-center gap-2">
                <Icon name="mic" size={18} />
                导唱（原唱人声）
              </span>
              <span className="num text-[#C8C8D0]">{vocal}%</span>
            </span>
            <Range label="导唱音量" value={vocal} onChange={setVocal} />
          </label>
        )}
        <div className="flex items-center justify-between">
          <span className="text-sm">升降调</span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              aria-label="降调"
              onClick={() => setKey(player.key - 1)}
              disabled={player.key <= -6}
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
              disabled={player.key >= 6}
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
          <span className="text-[13px] text-muted">已点 {queue.length + (cur ? 1 : 0)} 首</span>
        </div>
        {queue.length === 0 ? (
          <p className="m-0 py-4 text-center text-[13px] text-muted">队列是空的</p>
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
                    </span>
                  )}
                </div>
                <span className="num text-[13px] text-subtle">{fmtMs(q.song.duration)}</span>
                <IconButton icon="play" label={`立即唱 ${q.song.name}`} onClick={() => playQueuedNow(q)} className="bg-white/6 text-fg-2" />
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
    <div className="flex flex-col">
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
          <SongActions song={s} compact />
        </div>
      ))}
    </div>
  )
}

function SearchTab() {
  const [value, setValue] = useState('')
  const q = useDebounced(value.trim(), 350)
  const results = useInfiniteQuery({
    queryKey: ['search', q],
    queryFn: ({ pageParam }) => api.search(q, pageParam, 30),
    initialPageParam: 0,
    getNextPageParam: (last, pages) => (last.hasMore ? pages.reduce((n, p) => n + p.songs.length, 0) : undefined),
    enabled: q.length > 0,
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
          className="h-full min-w-0 flex-1 border-0 bg-transparent text-[15px] text-fg outline-none placeholder:text-subtle"
        />
      </label>
      {q ? (
        results.isLoading ? (
          <div className="flex justify-center py-10 text-muted">
            <Spinner />
          </div>
        ) : songs.length ? (
          <>
            <SongList songs={songs} />
            {results.hasNextPage && (
              <button
                type="button"
                onClick={() => results.fetchNextPage()}
                className="h-11 rounded-xl bg-white/6 text-sm text-fg-2"
              >
                {results.isFetchingNextPage ? '加载中…' : '加载更多'}
              </button>
            )}
          </>
        ) : (
          <EmptyNote>没有找到相关歌曲</EmptyNote>
        )
      ) : (
        <>
          <h2 className="m-0 px-0.5 text-[15px] font-semibold">{rec.data?.daily ? '每日推荐' : '热门推荐'}</h2>
          {rec.isLoading ? (
            <div className="flex justify-center py-10 text-muted">
              <Spinner />
            </div>
          ) : (
            <SongList songs={rec.data?.songs ?? []} />
          )}
        </>
      )}
    </div>
  )
}

export default function Remote() {
  const [tab, setTab] = useState<Tab>('remote')
  const connected = useApp((s) => s.connected)
  const queue = useApp((s) => s.state.queue)
  const current = useApp((s) => s.state.player.current)
  const count = queue.length + (current ? 1 : 0)
  useEffect(() => connect('remote'), [])
  useEffect(() => {
    document.title = '手机遥控 · Netease KTV'
  }, [])
  const tabs: { id: Tab; label: string; icon: IconName }[] = [
    { id: 'remote', label: '遥控', icon: 'remote' },
    { id: 'search', label: '点歌', icon: 'note' },
    { id: 'queue', label: count ? `已点 ${count}` : '已点', icon: 'list' },
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
      </header>

      <main className="relative min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        {tab === 'remote' && <RemoteTab />}
        {tab === 'search' && <SearchTab />}
        {tab === 'queue' && (
          <div className="flex flex-col gap-2">
            <h2 className="m-0 px-0.5 text-[15px] font-semibold">已点歌曲</h2>
            <QueueList />
          </div>
        )}
      </main>

      <nav
        aria-label="底部导航"
        className="relative grid h-[74px] shrink-0 grid-cols-3 border-t border-white/8 bg-ink/85 px-3 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl"
      >
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            aria-current={tab === t.id ? 'page' : undefined}
            className={clsx(
              'flex flex-col items-center justify-center gap-1 text-xs',
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
