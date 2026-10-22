import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useSearchParams } from 'react-router'
import clsx from 'clsx'
import type { PlaylistSummary } from '@shared/types'
import { api } from '../lib/api'
import { errorText, toast, useAccount, useDebounced } from '../lib/hooks'
import { connect, useApp } from '../store/app'
import { Icon, type IconName } from '../components/icons'
import { Cover, EmptyNote, Spinner } from '../components/ui'
import { RecCard, SongTable } from '../components/SongTable'
import { QueuePanel } from '../components/QueuePanel'
import { Leaderboard } from '../components/Leaderboard'
import { LoginDialog } from '../components/LoginDialog'
import { SettingsDialog } from '../components/SettingsDialog'

function useMediaQuery(query: string) {
  const [match, setMatch] = useState(() => window.matchMedia(query).matches)
  useEffect(() => {
    const m = window.matchMedia(query)
    const on = () => setMatch(m.matches)
    on()
    m.addEventListener('change', on)
    window.addEventListener('resize', on)
    return () => {
      m.removeEventListener('change', on)
      window.removeEventListener('resize', on)
    }
  }, [query])
  return match
}

type View =
  | { kind: 'recommend' }
  | { kind: 'search'; q: string }
  | { kind: 'toplists' }
  | { kind: 'scores' }
  | { kind: 'playlist'; id: number; name: string }

function useView(): [View, (v: View) => void] {
  const [params, setParams] = useSearchParams()
  const view = useMemo<View>(() => {
    const v = params.get('view')
    if (v === 'search' && params.get('q')) return { kind: 'search', q: params.get('q')! }
    if (v === 'toplists') return { kind: 'toplists' }
    if (v === 'scores') return { kind: 'scores' }
    if (v === 'playlist' && params.get('id'))
      return { kind: 'playlist', id: Number(params.get('id')), name: params.get('name') || '歌单' }
    return { kind: 'recommend' }
  }, [params])
  const go = (v: View) => {
    const next = new URLSearchParams()
    const token = params.get('token')
    if (token) next.set('token', token)
    if (v.kind !== 'recommend') next.set('view', v.kind)
    if (v.kind === 'search') next.set('q', v.q)
    if (v.kind === 'playlist') {
      next.set('id', String(v.id))
      next.set('name', v.name)
    }
    setParams(next)
  }
  return [view, go]
}

// ---------------- Sidebar ----------------

function NavButton({
  icon,
  label,
  active,
  onClick,
  indent,
}: {
  icon?: IconName
  label: string
  active?: boolean
  onClick: () => void
  indent?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={clsx(
        'flex w-full items-center gap-3 rounded-xl px-3 text-left transition-colors hover:bg-white/5',
        indent ? 'h-10 pl-11 text-sm' : 'h-11 text-[15px]',
        active ? 'bg-white/7 font-semibold text-fg' : indent ? 'text-[#B4B4BE]' : 'text-[#C8C8D0]',
      )}
    >
      {icon && <Icon name={icon} size={20} className={active ? 'text-accent' : undefined} />}
      <span className="truncate">{label}</span>
    </button>
  )
}

function Brand() {
  return (
    <div className="flex items-center gap-3 px-2.5">
      <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[linear-gradient(135deg,#FF4D7E_0%,#8B5CF6_100%)] text-white shadow-[0_8px_24px_rgba(255,77,126,0.35)]">
        <Icon name="mic" size={22} strokeWidth={2} />
      </div>
      <div className="flex flex-col">
        <span className="num text-[19px] font-bold tracking-[0.01em]">Netease KTV</span>
        <span className="text-xs text-muted">点歌台</span>
      </div>
    </div>
  )
}

function AccountCard({ onLogin }: { onLogin: () => void }) {
  const qc = useQueryClient()
  const { data: account, isLoading } = useAccount()
  if (isLoading) return <div className="h-[62px] rounded-2xl bg-white/4" />
  if (!account?.loggedIn)
    return (
      <button
        type="button"
        onClick={onLogin}
        className="flex items-center gap-3 rounded-2xl border border-white/8 bg-white/4 p-3 text-left hover:bg-white/7"
      >
        <span className="flex h-9 w-9 items-center justify-center rounded-full bg-white/8 text-fg-2">
          <Icon name="user" size={18} />
        </span>
        <span className="flex flex-col gap-0.5">
          <span className="text-sm font-semibold">登录网易云</span>
          <span className="text-xs text-muted">扫码登录后点歌</span>
        </span>
      </button>
    )
  return (
    <div className="flex items-center gap-3 rounded-2xl border border-white/6 bg-white/4 p-3">
      {account.avatarUrl ? (
        <Cover url={account.avatarUrl} seed={account.userId} px={80} className="h-9 w-9 rounded-full" />
      ) : (
        <span className="h-9 w-9 rounded-full bg-[linear-gradient(135deg,#FDE68A,#F97316)]" />
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-sm font-semibold">{account.nickname}</span>
        <span className={clsx('text-xs', account.vipType ? 'text-warn' : 'text-muted')}>
          {account.vipType ? '黑胶 VIP · 已登录' : '已登录'}
        </span>
      </div>
      <button
        type="button"
        aria-label="退出登录"
        title="退出登录"
        onClick={async () => {
          try {
            await api.logout()
            await qc.invalidateQueries()
            toast('已退出登录')
          } catch (e) {
            toast(errorText(e), 'error')
          }
        }}
        className="flex h-9 w-9 items-center justify-center rounded-[10px] text-muted hover:bg-white/10 hover:text-fg"
      >
        <Icon name="logout" size={17} />
      </button>
    </div>
  )
}

function Sidebar({
  view,
  go,
  onLogin,
  onSettings,
}: {
  view: View
  go: (v: View) => void
  onLogin: () => void
  onSettings: () => void
}) {
  const { data: account } = useAccount()
  const { data } = useQuery({ queryKey: ['playlists', account?.userId], queryFn: api.playlists, enabled: !!account?.loggedIn })
  const playlists = data?.playlists ?? []
  return (
    <nav aria-label="主导航" className="flex h-full flex-col gap-7 px-4 py-7">
      <Brand />
      <div className="flex flex-col gap-1">
        <div className="px-3 pb-1.5 text-xs tracking-[0.12em] text-subtle">发现</div>
        <NavButton icon="compass" label="为你推荐" active={view.kind === 'recommend'} onClick={() => go({ kind: 'recommend' })} />
        <NavButton icon="chart" label="热歌榜" active={view.kind === 'toplists'} onClick={() => go({ kind: 'toplists' })} />
        <NavButton icon="trophy" label="K 歌排行" active={view.kind === 'scores'} onClick={() => go({ kind: 'scores' })} />
        <Link
          to="/tv"
          target="_blank"
          className="flex h-11 items-center gap-3 rounded-xl px-3 text-[15px] text-[#C8C8D0] hover:bg-white/5"
        >
          <Icon name="tv" size={20} />
          打开主屏
        </Link>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-1">
        <div className="px-3 pb-1.5 text-xs tracking-[0.12em] text-subtle">我的音乐</div>
        {!account?.loggedIn ? (
          <p className="m-0 px-3 text-[13px] leading-6 text-muted">登录后显示你的歌单</p>
        ) : (
          <div className="-mx-1 flex min-h-0 flex-col gap-1 overflow-y-auto px-1">
            {playlists.map((p, i) => (
              <NavButton
                key={p.id}
                icon={i === 0 ? 'heart' : undefined}
                indent={i !== 0}
                label={i === 0 ? '我喜欢的音乐' : p.name}
                active={view.kind === 'playlist' && view.id === p.id}
                onClick={() => go({ kind: 'playlist', id: p.id, name: i === 0 ? '我喜欢的音乐' : p.name })}
              />
            ))}
          </div>
        )}
      </div>
      <div className="flex flex-col gap-2.5">
        <NavButton icon="sliders" label="设置" onClick={onSettings} />
        <AccountCard onLogin={onLogin} />
      </div>
    </nav>
  )
}

// ---------------- Search ----------------

function SearchBox({ initial, onSearch }: { initial: string; onSearch: (q: string) => void }) {
  const [value, setValue] = useState(initial)
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const inputRef = useRef<HTMLInputElement>(null)
  const debounced = useDebounced(value.trim(), 200)
  const { data } = useQuery({
    queryKey: ['suggest', debounced],
    queryFn: () => api.suggest(debounced),
    enabled: debounced.length > 0,
    staleTime: 60_000,
  })
  const items = open && value.trim() ? (data?.keywords ?? []).slice(0, 8) : []

  useEffect(() => setValue(initial), [initial])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        inputRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const submit = (q: string) => {
    const t = q.trim()
    if (!t) return
    setValue(t)
    setOpen(false)
    onSearch(t)
  }

  return (
    <div className="relative min-w-0 flex-[1_1_320px]">
      <label className="flex h-[52px] items-center gap-3 rounded-2xl border border-white/8 bg-white/6 px-4.5 focus-within:border-white/20">
        <Icon name="search" size={20} className="text-muted" />
        <span className="sr-only-x">搜索</span>
        <input
          ref={inputRef}
          type="search"
          value={value}
          placeholder="搜索歌曲、歌手、歌词…"
          role="combobox"
          aria-expanded={items.length > 0}
          aria-controls="suggest-list"
          aria-autocomplete="list"
          onChange={(e) => {
            setValue(e.target.value)
            setOpen(true)
            setActive(-1)
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setActive((a) => Math.min(items.length - 1, a + 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setActive((a) => Math.max(-1, a - 1))
            } else if (e.key === 'Enter') {
              submit(active >= 0 && items[active] ? items[active] : value)
            } else if (e.key === 'Escape') setOpen(false)
          }}
          className="h-full min-w-0 flex-1 border-0 bg-transparent text-base text-fg outline-none placeholder:text-subtle"
        />
        <span className="num hidden rounded-md border border-white/14 px-2 py-[3px] text-xs text-muted sm:inline">Ctrl K</span>
      </label>
      {items.length > 0 && (
        <ul
          id="suggest-list"
          role="listbox"
          className="glass absolute inset-x-0 top-[58px] z-30 m-0 list-none overflow-hidden rounded-2xl p-1.5 shadow-[0_20px_50px_rgba(0,0,0,0.5)]"
        >
          {items.map((k, i) => (
            <li key={k} role="option" aria-selected={i === active}>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => submit(k)}
                className={clsx(
                  'flex h-10 w-full items-center gap-3 rounded-xl px-3 text-left text-sm',
                  i === active ? 'bg-white/10' : 'hover:bg-white/6',
                )}
              >
                <Icon name="search" size={15} className="text-subtle" />
                {k}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** Compact status dot next to the search box; click for the separation service details. */
function SeparatorChip() {
  const sep = useApp((s) => s.state.separator)
  const connected = useApp((s) => s.connected)
  const [open, setOpen] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const state: 'connecting' | 'offline' | 'preparing' | 'ready' = !connected
    ? 'connecting'
    : !sep.online
      ? 'offline'
      : sep.ready === false
        ? 'preparing'
        : 'ready'
  const label = { connecting: '连接中', offline: '离线', preparing: '准备中', ready: '就绪' }[state]
  const color = { connecting: '#8E8E99', offline: '#8E8E99', preparing: '#FBBF24', ready: '#4ADE80' }[state]

  return (
    <div ref={boxRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
        title="伴奏分离服务状态"
        className={clsx(
          'flex h-10 items-center gap-2 rounded-full px-3.5 text-[13px] font-medium whitespace-nowrap transition-colors',
          state === 'ready' ? 'bg-[rgba(74,222,128,0.1)] text-ok hover:bg-[rgba(74,222,128,0.16)]' : 'bg-white/6 text-muted hover:bg-white/10',
        )}
      >
        <span
          aria-hidden="true"
          className={clsx('h-2 w-2 rounded-full', state === 'preparing' && 'ktv-pulse')}
          style={{ background: color, boxShadow: state === 'ready' ? '0 0 10px #4ADE80' : undefined }}
        />
        {label}
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="伴奏分离服务"
          className="glass absolute top-[48px] right-0 z-40 w-[300px] rounded-2xl p-4 shadow-[0_20px_50px_rgba(0,0,0,0.5)]"
        >
          <div className="mb-3 flex items-center gap-2">
            <Icon name="sparkles" size={17} className="text-accent" />
            <span className="text-sm font-semibold">AI 伴奏分离</span>
            <span className="ml-auto flex items-center gap-1.5 text-xs" style={{ color }}>
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
              {state === 'ready' ? '在线' : label}
            </span>
          </div>
          <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-[13px]">
            <dt className="text-muted">设备</dt>
            <dd className="m-0 truncate text-right" title={sep.device}>
              {sep.device || '—'}
            </dd>
            <dt className="text-muted">模型</dt>
            <dd className="m-0 truncate text-right" title={sep.model}>
              {sep.model || '—'}
            </dd>
            <dt className="text-muted">队列</dt>
            <dd className="m-0 text-right">{sep.pending} 首待处理</dd>
          </dl>
          {state === 'offline' && (
            <p className="m-0 mt-3 text-xs leading-5 text-muted">分离服务未连接，歌曲会以原曲播放；服务恢复后会自动生成伴奏。</p>
          )}
          {state === 'preparing' && (
            <p className="m-0 mt-3 text-xs leading-5 text-muted">首次启动正在下载分离模型（约 0.2–0.9 GB），完成后自动开始生成伴奏。</p>
          )}
          {state === 'connecting' && <p className="m-0 mt-3 text-xs leading-5 text-muted">正在连接 KTV 主机…</p>}
        </div>
      )}
    </div>
  )
}

// ---------------- Views ----------------

function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="m-0 text-xl font-bold">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  )
}

function Loading() {
  return (
    <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted">
      <Spinner /> 加载中…
    </div>
  )
}

function ErrorNote({ error, retry }: { error: unknown; retry?: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 py-12 text-sm text-muted">
      <span>{errorText(error)}</span>
      {retry && (
        <button type="button" onClick={retry} className="h-10 rounded-xl bg-white/8 px-4 text-fg hover:bg-white/12">
          重试
        </button>
      )}
    </div>
  )
}

const quickTags = ['华语', '粤语', '欧美', '日语', '经典老歌', '合唱', '民谣', '摇滚']

function RecommendView({ go }: { go: (v: View) => void }) {
  const { data: account } = useAccount()
  const q = useQuery({ queryKey: ['recommend', account?.userId ?? 0], queryFn: api.recommend })
  const songs = q.data?.songs ?? []
  return (
    <>
      <section className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <h1 className="m-0 text-[34px] font-bold tracking-[0.01em]">今晚想唱点什么？</h1>
          <p className="m-0 text-[15px] text-muted">从日推、歌单或搜索开始点歌，点过的歌会在后台提前生成伴奏</p>
        </div>
        <div role="group" aria-label="快速搜索" className="flex flex-wrap gap-2.5">
          {quickTags.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => go({ kind: 'search', q: t })}
              className="h-9 rounded-full border border-white/12 bg-white/4 px-4 text-sm font-medium text-fg-2 hover:border-white/25 hover:text-fg"
            >
              {t}
            </button>
          ))}
        </div>
      </section>
      {q.isLoading ? (
        <Loading />
      ) : q.isError ? (
        <ErrorNote error={q.error} retry={() => q.refetch()} />
      ) : (
        <>
          <Section title={q.data?.daily ? '每日推荐' : '热门推荐'}>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-5">
              {songs.slice(0, 6).map((s) => (
                <RecCard key={s.id} song={s} />
              ))}
            </div>
          </Section>
          {songs.length > 6 && (
            <Section title="热门可唱">
              <div className="overflow-x-auto">
                <SongTable songs={songs.slice(6)} />
              </div>
            </Section>
          )}
          {!songs.length && <EmptyNote>暂时没有推荐，试试搜索吧</EmptyNote>}
        </>
      )}
    </>
  )
}

function InfiniteSongs({ queryKey, fetchPage }: { queryKey: unknown[]; fetchPage: (offset: number) => ReturnType<typeof api.search> }) {
  const q = useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam }) => fetchPage(pageParam),
    initialPageParam: 0,
    getNextPageParam: (last, pages) => (last.hasMore ? pages.reduce((n, p) => n + p.songs.length, 0) : undefined),
  })
  const songs = useMemo(() => q.data?.pages.flatMap((p) => p.songs) ?? [], [q.data])
  if (q.isLoading) return <Loading />
  if (q.isError) return <ErrorNote error={q.error} retry={() => q.refetch()} />
  if (!songs.length) return <EmptyNote>没有找到相关歌曲</EmptyNote>
  return (
    <div className="flex flex-col gap-4">
      <div className="overflow-x-auto">
        <SongTable songs={songs} />
      </div>
      {q.hasNextPage && (
        <button
          type="button"
          onClick={() => q.fetchNextPage()}
          disabled={q.isFetchingNextPage}
          className="mx-auto h-11 rounded-xl bg-white/6 px-6 text-sm text-fg-2 hover:bg-white/10"
        >
          {q.isFetchingNextPage ? '加载中…' : '加载更多'}
        </button>
      )}
    </div>
  )
}

function SearchView({ q }: { q: string }) {
  return (
    <Section title={`“${q}” 的搜索结果`}>
      <InfiniteSongs queryKey={['search', q]} fetchPage={(offset) => api.search(q, offset, 30)} />
    </Section>
  )
}

function PlaylistCard({ p, onOpen }: { p: PlaylistSummary; onOpen: () => void }) {
  return (
    <button type="button" onClick={onOpen} className="group flex min-w-0 flex-col gap-2.5 text-left">
      <div className="aspect-square overflow-hidden rounded-[18px] shadow-[0_14px_30px_rgba(0,0,0,0.35)]">
        <Cover url={p.coverUrl} seed={p.id} px={400} className="h-full w-full transition-transform duration-500 group-hover:scale-[1.04]" />
      </div>
      <span className="truncate px-0.5 text-[15px] font-semibold">{p.name}</span>
      {p.description && <span className="-mt-2 truncate px-0.5 text-[13px] text-muted">{p.description}</span>}
    </button>
  )
}

function ToplistsView({ go }: { go: (v: View) => void }) {
  const q = useQuery({ queryKey: ['toplists'], queryFn: api.toplists, staleTime: 10 * 60_000 })
  return (
    <Section title="热歌榜">
      {q.isLoading ? (
        <Loading />
      ) : q.isError ? (
        <ErrorNote error={q.error} retry={() => q.refetch()} />
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-5">
          {q.data!.playlists.map((p) => (
            <PlaylistCard key={p.id} p={p} onOpen={() => go({ kind: 'playlist', id: p.id, name: p.name })} />
          ))}
        </div>
      )}
    </Section>
  )
}

function PlaylistView({ id, name, back }: { id: number; name: string; back: () => void }) {
  return (
    <Section
      title={name}
      action={
        <button type="button" onClick={back} className="inline-flex h-10 items-center gap-1 text-sm text-muted hover:text-fg">
          <Icon name="chevronLeft" size={16} /> 返回
        </button>
      }
    >
      <InfiniteSongs queryKey={['playlist', id]} fetchPage={(offset) => api.playlistTracks(id, offset, 100)} />
    </Section>
  )
}

// ---------------- Page ----------------

export default function Desk() {
  const [view, go] = useView()
  const [loginOpen, setLoginOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const wide = useMediaQuery('(min-width: 1280px)')
  const lg = useMediaQuery('(min-width: 1024px)')

  useEffect(() => connect('desk'), [])
  useEffect(() => {
    document.title = '点歌台 · Netease KTV'
  }, [])

  const content = (
    <>
      <div className="flex flex-wrap items-center gap-4">
        <SearchBox initial={view.kind === 'search' ? view.q : ''} onSearch={(q) => go({ kind: 'search', q })} />
        <SeparatorChip />
      </div>
      {view.kind === 'recommend' && <RecommendView go={go} />}
      {view.kind === 'search' && <SearchView q={view.q} />}
      {view.kind === 'toplists' && <ToplistsView go={go} />}
      {view.kind === 'scores' && (
        <Section title="K 歌排行">
          <Leaderboard manage />
        </Section>
      )}
      {view.kind === 'playlist' && <PlaylistView id={view.id} name={view.name} back={() => window.history.back()} />}
    </>
  )

  return (
    <div className="relative min-h-full overflow-hidden bg-ink text-fg lg:h-full">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-[380px] left-[160px] h-[760px] w-[760px] rounded-full opacity-[0.16] blur-[20px]"
        style={{ background: 'radial-gradient(circle, #FF4D7E 0%, rgba(0,0,0,0) 62%)' }}
      />
      <div className="relative grid min-h-full grid-cols-1 lg:h-full lg:grid-cols-[232px_minmax(0,1fr)] xl:grid-cols-[232px_minmax(0,1fr)_352px]">
        {lg ? (
          <aside className="min-h-0 border-r border-white/6">
            <Sidebar view={view} go={go} onLogin={() => setLoginOpen(true)} onSettings={() => setSettingsOpen(true)} />
          </aside>
        ) : (
          <MobileTopBar view={view} go={go} onLogin={() => setLoginOpen(true)} onSettings={() => setSettingsOpen(true)} />
        )}
        <main className="flex min-w-0 flex-col gap-8 px-4 pt-6 pb-10 sm:px-8 lg:overflow-y-auto lg:px-10 lg:pt-7">
          {content}
          {!wide && (
            <section className="rounded-3xl border border-white/6 bg-white/[0.015] p-5">
              <QueuePanel />
            </section>
          )}
        </main>
        {wide && (
          <aside aria-label="已点歌曲" className="min-h-0 border-l border-white/6 bg-white/[0.015] px-6 py-7">
            <QueuePanel />
          </aside>
        )}
      </div>
      <LoginDialog open={loginOpen} onClose={() => setLoginOpen(false)} />
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  )
}

function MobileTopBar({
  view,
  go,
  onLogin,
  onSettings,
}: {
  view: View
  go: (v: View) => void
  onLogin: () => void
  onSettings: () => void
}) {
  const { data: account } = useAccount()
  return (
    <header className="flex flex-col gap-4 border-b border-white/6 px-4 pt-5 pb-3 sm:px-8">
      <div className="flex items-center justify-between gap-3">
        <Brand />
        <div className="flex items-center gap-2">
          {!account?.loggedIn && (
            <button type="button" onClick={onLogin} className="h-10 rounded-xl bg-accent px-3.5 text-sm font-bold text-accent-ink">
              登录
            </button>
          )}
          <button
            type="button"
            onClick={onSettings}
            aria-label="设置"
            className="flex h-10 w-10 items-center justify-center rounded-xl border border-white/10 bg-white/5 text-fg-2"
          >
            <Icon name="sliders" size={18} />
          </button>
        </div>
      </div>
      <nav aria-label="主导航" className="-mx-1 flex gap-2 overflow-x-auto px-1">
        {(
          [
            ['recommend', '为你推荐'],
            ['toplists', '热歌榜'],
            ['scores', 'K 歌排行'],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            type="button"
            onClick={() => go({ kind: k })}
            className={clsx(
              'h-9 shrink-0 rounded-full border px-4 text-sm',
              view.kind === k ? 'border-fg bg-fg text-ink' : 'border-white/12 text-fg-2',
            )}
          >
            {label}
          </button>
        ))}
        <Link to="/m" className="flex h-9 shrink-0 items-center rounded-full border border-white/12 px-4 text-sm text-fg-2">
          手机遥控
        </Link>
      </nav>
    </header>
  )
}
