import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useSearchParams } from 'react-router'
import clsx from 'clsx'
import type { PlaylistSummary } from '@shared/types'
import { api, withFreshData } from '../lib/api'
import { DeskNavContext, type DeskNav } from '../lib/deskNav'
import { stopPreview } from '../lib/preview'
import { errorText, toast, useAccount, useDebounced, useHistory } from '../lib/hooks'
import { connect, useApp } from '../store/app'
import { Icon, type IconName } from '../components/icons'
import { Cover, EmptyNote, QueryError, Spinner } from '../components/ui'
import { RecCard, SongTable } from '../components/SongTable'
import { QueuePanel } from '../components/QueuePanel'
import { Leaderboard } from '../components/Leaderboard'
import { LoginDialog } from '../components/LoginDialog'
import { SettingsDialog } from '../components/SettingsDialog'
import { PlaylistNavButton } from '../components/PlaylistNav'
import {
  DEVICE_ONLY_NOTE,
  ImportedPlaylistChips,
  ImportedPlaylistsNav,
  ImportPlaylistDialog,
} from '../components/ImportPlaylist'
import { useImportedPlaylists } from '../lib/importedPlaylists'

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
  | { kind: 'history' }
  | { kind: 'album'; id: number; name: string }
  | { kind: 'artist'; id: number; name: string }
  | { kind: 'playlist'; id: number; name: string }

function useView(): [View, (v: View) => void] {
  const [params, setParams] = useSearchParams()
  const view = useMemo<View>(() => {
    const v = params.get('view')
    if (v === 'search' && params.get('q')) return { kind: 'search', q: params.get('q')! }
    if (v === 'toplists') return { kind: 'toplists' }
    if (v === 'scores') return { kind: 'scores' }
    if (v === 'history') return { kind: 'history' }
    if ((v === 'album' || v === 'artist') && params.get('id'))
      return { kind: v, id: Number(params.get('id')), name: params.get('name') || '' }
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
    if (v.kind === 'playlist' || v.kind === 'album' || v.kind === 'artist') {
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
        {!!account.vipType && <span className="truncate text-xs whitespace-nowrap text-warn">黑胶 VIP</span>}
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
  onImport,
}: {
  view: View
  go: (v: View) => void
  onLogin: () => void
  onSettings: () => void
  onImport: () => void
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
        <NavButton icon="clock" label="点歌记录" active={view.kind === 'history'} onClick={() => go({ kind: 'history' })} />
        <Link
          to="/tv"
          target="_blank"
          className="flex h-11 items-center gap-3 rounded-xl px-3 text-[15px] text-[#C8C8D0] hover:bg-white/5"
        >
          <Icon name="tv" size={20} />
          打开主屏
        </Link>
      </div>
      <div className="-mx-1 flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-1">
        <div className="flex flex-col gap-1">
          <div className="px-3 pb-1.5 text-xs tracking-[0.12em] text-subtle">我的歌单</div>
          {!account?.loggedIn ? (
            <p className="m-0 px-3 text-[13px] leading-6 text-muted">登录后显示你的歌单</p>
          ) : (
            playlists.map((p, i) => (
              <PlaylistNavButton
                key={p.id}
                p={p}
                liked={i === 0}
                label={i === 0 ? '我喜欢的音乐' : p.name}
                active={view.kind === 'playlist' && view.id === p.id}
                onClick={() => go({ kind: 'playlist', id: p.id, name: i === 0 ? '我喜欢的音乐' : p.name })}
              />
            ))
          )}
        </div>
        <ImportedPlaylistsNav
          activeId={view.kind === 'playlist' ? view.id : undefined}
          onOpen={(p) => go({ kind: 'playlist', id: p.id, name: p.name })}
          onImport={onImport}
        />
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
      <label className="flex h-[52px] items-center gap-3 rounded-2xl border border-white/10 bg-[#16161E] px-4.5 shadow-[0_10px_30px_rgba(0,0,0,0.35)] focus-within:border-white/20">
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
          className="absolute border border-white/10 bg-[#17171F] inset-x-0 top-[58px] z-30 m-0 list-none overflow-hidden rounded-2xl p-1.5 shadow-[0_20px_50px_rgba(0,0,0,0.5)]"
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
        aria-label={`伴奏分离：${label}`}
        className={clsx(
          'flex h-10 items-center gap-2 rounded-full px-3.5 text-[13px] font-medium whitespace-nowrap transition-colors',
          // Opaque: the chip sits in the pinned search row, over scrolling content.
          state === 'ready' ? 'bg-[#13211A] text-ok hover:bg-[#172a20]' : 'bg-[#1A1A22] text-muted hover:bg-[#22222b]',
        )}
      >
        <span
          aria-hidden="true"
          className={clsx('h-2 w-2 rounded-full', state === 'preparing' && 'ktv-pulse')}
          style={{ background: color, boxShadow: state === 'ready' ? '0 0 10px #4ADE80' : undefined }}
        />
        {/* Phones: just the dot, so the pinned search row stays one line. */}
        <span className="max-sm:hidden">{label}</span>
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="伴奏分离服务"
          className="absolute border border-white/10 bg-[#17171F] top-[48px] right-0 z-40 w-[300px] rounded-2xl p-4 shadow-[0_20px_50px_rgba(0,0,0,0.5)]"
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

/**
 * Top-right page actions: refresh (re-fetch this page's lists from NetEase, skipping the server's
 * data cache) and, on sub-pages, back.
 */
function PageActions({ back, children }: { back?: () => void; children?: ReactNode }) {
  const qc = useQueryClient()
  const [busy, setBusy] = useState(false)
  async function refresh() {
    setBusy(true)
    try {
      await withFreshData(() => qc.refetchQueries({ type: 'active' }))
    } catch (e) {
      toast(errorText(e), 'error')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flex shrink-0 items-center gap-1">
      {children}
      <button
        type="button"
        onClick={refresh}
        disabled={busy}
        aria-label="刷新"
        title="刷新：重新从网易云获取"
        className="flex h-10 w-10 items-center justify-center rounded-xl text-muted transition-colors hover:bg-white/6 hover:text-fg disabled:opacity-60"
      >
        <Icon name="refresh" size={18} className={busy ? 'ktv-spin' : undefined} />
      </button>
      {back && (
        <button
          type="button"
          onClick={back}
          className="inline-flex h-10 items-center gap-1 rounded-xl px-2 text-sm whitespace-nowrap text-muted hover:bg-white/6 hover:text-fg"
        >
          <Icon name="chevronLeft" size={16} /> 返回
        </button>
      )}
    </div>
  )
}

function Loading() {
  return (
    <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted">
      <Spinner /> 加载中…
    </div>
  )
}

function ErrorNote({ error, retry, retrying }: { error: unknown; retry: () => void; retrying?: boolean }) {
  return <QueryError error={new Error(errorText(error))} onRetry={retry} retrying={retrying} />
}

const quickTags = ['华语', '粤语', '欧美', '日语', '经典老歌', '合唱', '民谣', '摇滚']

function RecommendView({ go }: { go: (v: View) => void }) {
  const { data: account } = useAccount()
  const q = useQuery({ queryKey: ['recommend', account?.userId ?? 0], queryFn: api.recommend })
  const songs = q.data?.songs ?? []
  return (
    <>
      <section className="flex flex-col gap-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex flex-col gap-1.5">
            <h1 className="m-0 text-[34px] font-bold tracking-[0.01em]">今晚想唱点什么？</h1>
            <p className="m-0 text-[15px] text-muted">从日推、歌单或搜索开始点歌，点过的歌会在后台提前生成伴奏</p>
          </div>
          <PageActions />
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
        <ErrorNote error={q.error} retry={() => q.refetch()} retrying={q.isFetching} />
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
  // Keep already-loaded results on screen if a later refetch fails.
  if (q.isError && !songs.length) return <ErrorNote error={q.error} retry={() => q.refetch()} retrying={q.isFetching} />
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
          {q.isFetchingNextPage ? '加载中…' : q.isFetchNextPageError ? '加载失败，点击重试' : '加载更多'}
        </button>
      )}
    </div>
  )
}

function SearchView({ q }: { q: string }) {
  return (
    <Section title={`“${q}” 的搜索结果`} action={<PageActions />}>
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
    <Section title="热歌榜" action={<PageActions />}>
      {q.isLoading ? (
        <Loading />
      ) : q.isError ? (
        <ErrorNote error={q.error} retry={() => q.refetch()} retrying={q.isFetching} />
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
  const imported = useImportedPlaylists().some((p) => p.id === id)
  return (
    <Section
      title={name}
      action={<PageActions back={back} />}
    >
      {imported && (
        <p className="m-0 -mt-1 flex items-center gap-2 text-xs text-muted">
          <Icon name="link" size={14} className="shrink-0" />
          临时歌单 · {DEVICE_ONLY_NOTE}
        </p>
      )}
      <InfiniteSongs queryKey={['playlist', id]} fetchPage={(offset) => api.playlistTracks(id, offset, 100)} />
    </Section>
  )
}

function DetailHeader({
  kind,
  title,
  cover,
  round,
  meta,
  back,
}: {
  kind: string
  title: string
  cover: ReactNode
  round?: boolean
  meta?: ReactNode
  back: () => void
}) {
  return (
    <div className="flex items-start gap-4 sm:gap-6">
      <div
        className={clsx(
          'h-24 w-24 shrink-0 overflow-hidden shadow-[0_14px_30px_rgba(0,0,0,0.4)] sm:h-36 sm:w-36',
          round ? 'rounded-full' : 'rounded-[20px]',
        )}
      >
        {cover}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2 pt-1">
        <span className="text-xs tracking-[0.12em] text-subtle">{kind}</span>
        <h1 className="m-0 text-2xl leading-tight font-bold break-words sm:text-[30px]">{title}</h1>
        {meta && <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted">{meta}</div>}
      </div>
      <PageActions back={back} />
    </div>
  )
}

function AlbumView({ id, name, go, back }: { id: number; name: string; go: (v: View) => void; back: () => void }) {
  const q = useQuery({ queryKey: ['album', id], queryFn: () => api.album(id), staleTime: 10 * 60_000 })
  const a = q.data
  const year = a?.publishTime ? new Date(a.publishTime).getFullYear() : null
  return (
    <section className="flex flex-col gap-6">
      <DetailHeader
        kind="专辑"
        title={a?.name || name}
        back={back}
        cover={<Cover url={a?.picUrl} seed={id} px={400} className="h-full w-full" />}
        meta={
          a && (
            <>
              {a.artists.map((ar, i) => (
                <span key={ar.id || i}>
                  {ar.id ? (
                    <button
                      type="button"
                      onClick={() => go({ kind: 'artist', id: ar.id, name: ar.name })}
                      className="font-semibold text-fg-2 hover:text-fg hover:underline"
                    >
                      {ar.name}
                    </button>
                  ) : (
                    ar.name
                  )}
                </span>
              ))}
              {year && <span className="num">· {year}</span>}
              {a.company && <span>· {a.company}</span>}
              <span className="num">· {a.songs.length} 首</span>
            </>
          )
        }
      />
      {q.isLoading ? (
        <Loading />
      ) : q.isError ? (
        <ErrorNote error={q.error} retry={() => q.refetch()} retrying={q.isFetching} />
      ) : a!.songs.length ? (
        <div className="overflow-x-auto">
          <SongTable songs={a!.songs} />
        </div>
      ) : (
        <EmptyNote>这张专辑没有歌曲</EmptyNote>
      )}
    </section>
  )
}

function ArtistView({ id, name, back }: { id: number; name: string; back: () => void }) {
  const q = useQuery({ queryKey: ['artist', id], queryFn: () => api.artist(id), staleTime: 10 * 60_000 })
  const a = q.data
  return (
    <section className="flex flex-col gap-6">
      <DetailHeader
        kind="歌手"
        title={a?.name || name}
        back={back}
        round
        cover={<Cover url={a?.picUrl} seed={id} px={400} className="h-full w-full" />}
        meta={
          a && (
            <>
              {a.alias.length > 0 && <span>{a.alias.join(' / ')}</span>}
              <span className="num">
                {a.alias.length > 0 && '· '}单曲 {a.songCount} · 专辑 {a.albumCount}
              </span>
            </>
          )
        }
      />
      <Section title="热门歌曲">
        <InfiniteSongs queryKey={['artistSongs', id]} fetchPage={(offset) => api.artistSongs(id, offset, 50)} />
      </Section>
    </section>
  )
}

function HistoryView() {
  const q = useHistory()
  const songs = q.data?.songs ?? []
  return (
    <Section
      title="点歌记录"
      action={
        <PageActions>{songs.length > 0 && <span className="num mr-2 text-sm text-muted">最近 {songs.length} 首</span>}</PageActions>
      }
    >
      <p className="m-0 -mt-1 text-sm text-muted">最近点过的 50 首歌，最新的在最前面。再点一次就会回到最前面。</p>
      {q.isLoading ? (
        <Loading />
      ) : q.isError && !q.data ? (
        <ErrorNote error={q.error} retry={() => q.refetch()} retrying={q.isFetching} />
      ) : songs.length ? (
        <SongTable songs={songs} />
      ) : (
        <EmptyNote>还没有点过歌</EmptyNote>
      )}
    </Section>
  )
}

// ---------------- Page ----------------

export default function Desk() {
  const [view, go] = useView()
  const [loginOpen, setLoginOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const wide = useMediaQuery('(min-width: 1280px)')
  const lg = useMediaQuery('(min-width: 1024px)')

  useEffect(() => connect('desk'), [])
  useEffect(() => {
    document.title = '点歌台 · Netease KTV'
  }, [])
  const goRef = useRef(go)
  goRef.current = go
  const nav = useMemo<DeskNav>(
    () => ({
      openAlbum: (id, name) => goRef.current({ kind: 'album', id, name }),
      openArtist: (id, name) => goRef.current({ kind: 'artist', id, name }),
    }),
    [],
  )
  // 试听 stops when leaving the page or switching views.
  useEffect(() => stopPreview, [])
  const viewKey = JSON.stringify(view)
  useEffect(() => stopPreview(), [viewKey])

  const content = (
    <>
      {/* Search stays pinned to the top while the page scrolls. */}
      <div className="pointer-events-none sticky top-0 z-30 -mx-4 -mt-6 flex items-center gap-3 px-4 pt-6 pb-3 sm:-mx-8 sm:gap-4 sm:px-8 lg:-mx-10 lg:-mt-7 lg:px-10 lg:pt-7 [&>*]:pointer-events-auto">
        <SearchBox initial={view.kind === 'search' ? view.q : ''} onSearch={(q) => go({ kind: 'search', q })} />
        <SeparatorChip />
      </div>
      {view.kind === 'recommend' && <RecommendView go={go} />}
      {view.kind === 'search' && <SearchView q={view.q} />}
      {view.kind === 'toplists' && <ToplistsView go={go} />}
      {view.kind === 'scores' && (
        <Section title="K 歌排行" action={<PageActions />}>
          <Leaderboard manage />
        </Section>
      )}
      {view.kind === 'history' && <HistoryView />}
      {view.kind === 'album' && <AlbumView key={view.id} id={view.id} name={view.name} go={go} back={() => window.history.back()} />}
      {view.kind === 'artist' && <ArtistView key={view.id} id={view.id} name={view.name} back={() => window.history.back()} />}
      {view.kind === 'playlist' && <PlaylistView id={view.id} name={view.name} back={() => window.history.back()} />}
    </>
  )

  return (
    <DeskNavContext.Provider value={nav}>
    <div className="relative min-h-full overflow-clip bg-ink text-fg lg:h-full">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-[380px] left-[160px] h-[760px] w-[760px] rounded-full opacity-[0.16] blur-[20px]"
        style={{ background: 'radial-gradient(circle, #FF4D7E 0%, rgba(0,0,0,0) 62%)' }}
      />
      <div className="relative grid min-h-full grid-cols-1 lg:h-full lg:grid-cols-[232px_minmax(0,1fr)] xl:grid-cols-[232px_minmax(0,1fr)_352px]">
        {lg ? (
          <aside className="min-h-0 border-r border-white/6">
            <Sidebar
              view={view}
              go={go}
              onLogin={() => setLoginOpen(true)}
              onSettings={() => setSettingsOpen(true)}
              onImport={() => setImportOpen(true)}
            />
          </aside>
        ) : (
          <MobileTopBar
            view={view}
            go={go}
            onLogin={() => setLoginOpen(true)}
            onSettings={() => setSettingsOpen(true)}
            onImport={() => setImportOpen(true)}
          />
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
      <ImportPlaylistDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={(p) => go({ kind: 'playlist', id: p.id, name: p.name })}
      />
    </div>
    </DeskNavContext.Provider>
  )
}

function MobileTopBar({
  view,
  go,
  onLogin,
  onSettings,
  onImport,
}: {
  view: View
  go: (v: View) => void
  onLogin: () => void
  onSettings: () => void
  onImport: () => void
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
            ['history', '点歌记录'],
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
      <ImportedPlaylistChips
        activeId={view.kind === 'playlist' ? view.id : undefined}
        onOpen={(p) => go({ kind: 'playlist', id: p.id, name: p.name })}
        onImport={onImport}
      />
    </header>
  )
}
