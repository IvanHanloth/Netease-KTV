import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useSearchParams } from 'react-router'
import clsx from 'clsx'
import type { PlaylistSummary } from '@shared/types'
import { api } from '../../lib/api'
import { errorText, toast, useAccount } from '../../lib/hooks'
import { useApp } from '../../store/app'
import { Icon, type IconName } from '../../components/icons'
import { ConfirmDialog, Cover } from '../../components/ui'
import { QueuePanel } from '../../components/QueuePanel'
import { PlaylistNavButton } from '../../components/PlaylistNav'
import { ImportedPlaylistChips, ImportedPlaylistsNav } from '../../components/ImportPlaylist'

/** 点歌台 navigation: the URL-backed view, the sidebar, the phone top bar, account and the queue drawer. */

export function useMediaQuery(query: string) {
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

type FsDocument = Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => void }
type FsElement = HTMLElement & { webkitRequestFullscreen?: () => void }

/** 全屏: the whole page fills the screen (handy on a 点歌台 tablet / kiosk). */
export function useFullscreen() {
  const doc = document as FsDocument
  const current = () => !!(doc.fullscreenElement ?? doc.webkitFullscreenElement)
  const [on, setOn] = useState(current)
  useEffect(() => {
    const update = () => setOn(current())
    document.addEventListener('fullscreenchange', update)
    document.addEventListener('webkitfullscreenchange', update)
    return () => {
      document.removeEventListener('fullscreenchange', update)
      document.removeEventListener('webkitfullscreenchange', update)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const el = document.documentElement as FsElement
  // iPhone Safari has no page fullscreen at all: the button is hidden there.
  const supported = !!(el.requestFullscreen || el.webkitRequestFullscreen)
  const toggle = () => {
    if (current()) {
      if (doc.exitFullscreen) void doc.exitFullscreen().catch(() => {})
      else doc.webkitExitFullscreen?.()
      return
    }
    if (el.requestFullscreen) void el.requestFullscreen().catch(() => toast('浏览器不允许全屏', 'error'))
    else el.webkitRequestFullscreen?.()
  }
  return { on, supported, toggle }
}

export type View =
  | { kind: 'recommend' }
  | { kind: 'search'; q: string }
  | { kind: 'toplists' }
  | { kind: 'scores' }
  | { kind: 'history' }
  | { kind: 'album'; id: number; name: string }
  | { kind: 'artist'; id: number; name: string }
  | { kind: 'playlist'; id: number; name: string }

export function useView(): [View, (v: View) => void] {
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

/** The 发现 entries, for the sidebar and the phone top bar alike. */
export const DISCOVER_NAV = [
  { kind: 'recommend', label: '为你推荐', icon: 'compass' },
  { kind: 'toplists', label: '热歌榜', icon: 'chart' },
  { kind: 'scores', label: 'K 歌排行', icon: 'trophy' },
  { kind: 'history', label: '点歌记录', icon: 'clock' },
] as const satisfies readonly { kind: View['kind']; label: string; icon: IconName }[]

/** The account's own playlists; the first one is 我喜欢的音乐. */
export function useMyPlaylists() {
  const { data: account } = useAccount()
  const { data } = useQuery({ queryKey: ['playlists', account?.userId], queryFn: api.playlists, enabled: !!account?.loggedIn })
  return { loggedIn: !!account?.loggedIn, playlists: data?.playlists ?? [] }
}

export const playlistLabel = (p: PlaylistSummary, i: number) => (i === 0 ? '我喜欢的音乐' : p.name)

/** Log out of NetEase, after asking (every device loses 点歌 until someone logs in again). */
export function useLogout() {
  const qc = useQueryClient()
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const dialog = (
    <ConfirmDialog
      open={asking}
      title="退出网易云账号？"
      message="退出后所有设备都无法点歌，需要重新扫码登录。"
      confirmLabel="退出登录"
      busy={busy}
      onConfirm={async () => {
        setBusy(true)
        try {
          await api.logout()
          await qc.invalidateQueries()
          toast('已退出登录')
          setAsking(false)
        } catch (e) {
          toast(errorText(e), 'error')
        } finally {
          setBusy(false)
        }
      }}
      onClose={() => setAsking(false)}
    />
  )
  return { ask: () => setAsking(true), dialog }
}

export function NavButton({
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

export function Brand() {
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

export function AccountCard({ onLogin }: { onLogin: () => void }) {
  const { data: account, isLoading } = useAccount()
  const logout = useLogout()
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
        onClick={logout.ask}
        className="flex h-9 w-9 items-center justify-center rounded-[10px] text-muted hover:bg-white/10 hover:text-fg"
      >
        <Icon name="logout" size={17} />
      </button>
      {logout.dialog}
    </div>
  )
}

export function Sidebar({
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
  const { loggedIn, playlists } = useMyPlaylists()
  const fullscreen = useFullscreen()
  return (
    <nav aria-label="主导航" className="flex h-full flex-col gap-7 px-4 py-7">
      <Brand />
      <div className="flex flex-col gap-1">
        <div className="px-3 pb-1.5 text-xs tracking-[0.12em] text-subtle">发现</div>
        {DISCOVER_NAV.map((n) => (
          <NavButton key={n.kind} icon={n.icon} label={n.label} active={view.kind === n.kind} onClick={() => go({ kind: n.kind })} />
        ))}
        <Link
          to="/tv"
          target="_blank"
          className="flex h-11 items-center gap-3 rounded-xl px-3 text-[15px] text-[#C8C8D0] hover:bg-white/5"
        >
          <Icon name="tv" size={20} />
          打开大屏
        </Link>
      </div>
      <div className="-mx-1 flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-1">
        <div className="flex flex-col gap-1">
          <div className="px-3 pb-1.5 text-xs tracking-[0.12em] text-subtle">我的歌单</div>
          {!loggedIn ? (
            <p className="m-0 px-3 text-[13px] leading-6 text-muted">登录后显示你的歌单</p>
          ) : (
            playlists.map((p, i) => (
              <PlaylistNavButton
                key={p.id}
                p={p}
                liked={i === 0}
                label={playlistLabel(p, i)}
                active={view.kind === 'playlist' && view.id === p.id}
                onClick={() => go({ kind: 'playlist', id: p.id, name: playlistLabel(p, i) })}
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
        {fullscreen.supported && (
          <NavButton icon={fullscreen.on ? 'shrink' : 'expand'} label={fullscreen.on ? '退出全屏' : '全屏'} onClick={fullscreen.toggle} />
        )}
        <NavButton icon="sliders" label="设置" onClick={onSettings} />
        <AccountCard onLogin={onLogin} />
      </div>
    </nav>
  )
}

export function MobileTopBar({
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
  const { loggedIn, playlists } = useMyPlaylists()
  const logout = useLogout()
  const fullscreen = useFullscreen()
  return (
    <header className="flex flex-col gap-4 border-b border-white/6 px-4 pt-5 pb-3 sm:px-8">
      <div className="flex items-center justify-between gap-3">
        <Brand />
        <div className="flex items-center gap-2">
          {!account?.loggedIn ? (
            <button type="button" onClick={onLogin} className="h-10 shrink-0 rounded-xl bg-accent px-3.5 text-sm font-bold whitespace-nowrap text-accent-ink">
              登录
            </button>
          ) : (
            <button
              type="button"
              onClick={logout.ask}
              title={`${account.nickname} · 退出登录`}
              aria-label={`${account.nickname}，退出登录`}
              className="flex h-10 w-10 items-center justify-center overflow-hidden rounded-full border border-white/10"
            >
              {account.avatarUrl ? (
                <Cover url={account.avatarUrl} seed={account.userId} px={80} className="h-full w-full" />
              ) : (
                <Icon name="user" size={18} />
              )}
            </button>
          )}
          {logout.dialog}
          {fullscreen.supported && (
            <button
              type="button"
              onClick={fullscreen.toggle}
              aria-label={fullscreen.on ? '退出全屏' : '全屏'}
              title={fullscreen.on ? '退出全屏' : '全屏'}
              // The narrowest phones have no room for it next to 登录 and 设置.
              className="hidden h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/5 text-fg-2 min-[400px]:flex"
            >
              <Icon name={fullscreen.on ? 'shrink' : 'expand'} size={18} />
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
        {DISCOVER_NAV.map((n) => (
          <button
            key={n.kind}
            type="button"
            onClick={() => go({ kind: n.kind })}
            className={clsx(
              'h-9 shrink-0 rounded-full border px-4 text-sm',
              view.kind === n.kind ? 'border-fg bg-fg text-ink' : 'border-white/12 text-fg-2',
            )}
          >
            {n.label}
          </button>
        ))}
        <Link to="/m" className="flex h-9 shrink-0 items-center rounded-full border border-white/12 px-4 text-sm text-fg-2">
          手机遥控
        </Link>
        <Link to="/tv" target="_blank" className="flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-white/12 px-4 text-sm text-fg-2">
          <Icon name="tv" size={15} />
          打开大屏
        </Link>
      </nav>
      {loggedIn && playlists.length > 0 && (
        <nav aria-label="我的歌单" className="-mx-1 flex gap-2 overflow-x-auto px-1">
          {playlists.map((p, i) => {
            const on = view.kind === 'playlist' && view.id === p.id
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => go({ kind: 'playlist', id: p.id, name: playlistLabel(p, i) })}
                aria-current={on ? 'page' : undefined}
                className={clsx(
                  'flex h-9 max-w-[200px] shrink-0 items-center gap-2 rounded-full border pr-4 pl-1.5 text-sm',
                  on ? 'border-fg bg-fg text-ink' : 'border-white/12 text-fg-2',
                )}
              >
                <Cover url={p.coverUrl} seed={p.id} px={60} className="h-6 w-6 rounded-full" />
                <span className="truncate">{playlistLabel(p, i)}</span>
              </button>
            )
          })}
        </nav>
      )}
      <ImportedPlaylistChips
        activeId={view.kind === 'playlist' ? view.id : undefined}
        onOpen={(p) => go({ kind: 'playlist', id: p.id, name: p.name })}
        onImport={onImport}
      />
    </header>
  )
}

/** 1024–1279 px: the queue opens from this chip instead of sitting below the song lists. */
export function QueueChip({ onOpen }: { onOpen: () => void }) {
  const count = useApp((st) => st.state.queue.length + (st.state.player.current ? 1 : 0))
  const playing = useApp((st) => st.state.player.playing && !!st.state.player.current)
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-haspopup="dialog"
      className="flex h-10 shrink-0 items-center gap-2 rounded-full bg-[#1A1A22] px-3.5 text-[13px] font-medium whitespace-nowrap text-fg-2 hover:bg-[#22222b]"
    >
      <Icon name="list" size={16} className={playing ? 'text-accent' : undefined} />
      已点 <span className="num">{count}</span>
    </button>
  )
}

/** The queue panel in a right-edge drawer (1024–1279 px). */
export function QueueDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
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
      aria-label="已点歌曲"
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose()
      }}
      className="m-0 ml-auto h-full max-h-none w-[380px] max-w-[90vw] border-0 border-l border-white/10 bg-panel p-0 text-fg backdrop:bg-black/50 backdrop:backdrop-blur-sm"
    >
      {open && (
        <div className="flex h-full flex-col gap-3 px-6 py-6">
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="flex h-10 w-10 items-center justify-center self-end rounded-xl text-muted hover:bg-white/8 hover:text-fg"
          >
            <Icon name="x" size={20} />
          </button>
          <div className="min-h-0 flex-1">
            <QueuePanel />
          </div>
        </div>
      )}
    </dialog>
  )
}
