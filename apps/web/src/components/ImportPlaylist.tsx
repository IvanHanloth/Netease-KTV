import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import type { PlaylistSummary } from '@shared/types'
import { api, ApiError, isRetryable } from '../lib/api'
import { errorText, toast } from '../lib/hooks'
import {
  addImportedPlaylist,
  removeImportedPlaylist,
  useImportedPlaylists,
  type ImportedPlaylist,
} from '../lib/importedPlaylists'
import { Icon } from './icons'
import { Cover, Dialog, Spinner } from './ui'

export const DEVICE_ONLY_NOTE = '仅保存在这台设备，不会同步到其他设备或网易云账号'

type ResolveState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'found'; playlist: PlaylistSummary }
  | { kind: 'error'; message: string; retryable: boolean }

/**
 * Paste a NetEase playlist link / share text / id, preview what was found, then import it
 * into this device's local list. Opens the imported playlist via `onImported`.
 */
export function ImportPlaylistDialog({
  open,
  onClose,
  onImported,
}: {
  open: boolean
  onClose: () => void
  onImported?: (p: PlaylistSummary) => void
}) {
  const [text, setText] = useState('')
  const [state, setState] = useState<ResolveState>({ kind: 'idle' })
  const seq = useRef(0)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (!open) return
    setText('')
    setState({ kind: 'idle' })
    const t = window.setTimeout(() => inputRef.current?.focus(), 60)
    return () => window.clearTimeout(t)
  }, [open])

  const resolve = async () => {
    const q = text.trim()
    if (!q) return
    const id = ++seq.current
    setState({ kind: 'loading' })
    try {
      const playlist = await api.resolvePlaylist(q)
      if (id === seq.current) setState({ kind: 'found', playlist })
    } catch (e) {
      if (id !== seq.current) return
      const message =
        e instanceof ApiError && e.status === 400
          ? e.message || '没有识别出歌单，请粘贴网易云歌单链接或歌单 ID'
          : e instanceof ApiError && e.status === 404
            ? e.message || '歌单不存在或无法访问'
            : errorText(e)
      setState({ kind: 'error', message, retryable: isRetryable(e) })
    }
  }

  const confirm = () => {
    if (state.kind !== 'found') return
    addImportedPlaylist(state.playlist)
    toast(`已导入「${state.playlist.name}」`)
    onImported?.(state.playlist)
    onClose()
  }

  return (
    <Dialog open={open} onClose={onClose} title="导入歌单" width={500} sheet>
      <div className="flex flex-col gap-4">
        <label className="flex flex-col gap-2">
          <span className="text-sm text-fg-2">粘贴网易云歌单链接、分享文本或歌单 ID</span>
          <textarea
            ref={inputRef}
            value={text}
            onChange={(e) => {
              setText(e.target.value)
              if (state.kind !== 'loading') setState({ kind: 'idle' })
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void resolve()
              }
            }}
            rows={3}
            placeholder="例如：分享歌单 https://163cn.tv/xxxxxx 或 https://music.163.com/playlist?id=123456"
            className="w-full resize-none rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-[15px] leading-6 text-fg outline-none placeholder:text-subtle focus:border-white/25"
          />
        </label>

        {state.kind === 'found' ? (
          <div className="flex items-center gap-3.5 rounded-2xl border border-white/10 bg-white/4 p-3">
            <Cover url={state.playlist.coverUrl} seed={state.playlist.id} px={160} className="h-16 w-16 rounded-xl" />
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="truncate text-[16px] font-semibold">{state.playlist.name}</span>
              <span className="text-[13px] text-muted">{state.playlist.trackCount} 首歌</span>
            </div>
            <Icon name="check" size={20} className="shrink-0 text-ok" />
          </div>
        ) : state.kind === 'error' ? (
          <div
            role="alert"
            className="flex items-center gap-2.5 rounded-2xl border border-[rgba(255,77,126,0.25)] bg-[rgba(255,77,126,0.08)] px-3.5 py-3 text-[13px] leading-5 text-accent-soft"
          >
            <Icon name="alert" size={16} className="shrink-0" />
            <span className="min-w-0 flex-1">{state.message}</span>
            {state.retryable && (
              <button
                type="button"
                onClick={() => void resolve()}
                className="h-8 shrink-0 rounded-lg bg-white/8 px-3 text-[13px] whitespace-nowrap text-fg hover:bg-white/14"
              >
                重试
              </button>
            )}
          </div>
        ) : null}

        <p className="m-0 flex items-start gap-2 text-xs leading-5 text-muted">
          <Icon name="info" size={14} className="mt-0.5 shrink-0" />
          {DEVICE_ONLY_NOTE}
        </p>

        <div className="flex justify-end gap-2.5">
          <button
            type="button"
            onClick={onClose}
            className="h-11 rounded-xl px-4 text-sm whitespace-nowrap text-fg-2 hover:bg-white/6"
          >
            取消
          </button>
          {state.kind === 'found' ? (
            <button
              type="button"
              onClick={confirm}
              className="h-11 rounded-xl bg-accent px-5 text-sm font-bold whitespace-nowrap text-accent-ink"
            >
              导入到本设备
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void resolve()}
              disabled={!text.trim() || state.kind === 'loading'}
              className="flex h-11 items-center gap-2 rounded-xl bg-white/10 px-5 text-sm font-semibold whitespace-nowrap text-fg hover:bg-white/14 disabled:opacity-40"
            >
              {state.kind === 'loading' && <Spinner size={16} />}
              {state.kind === 'loading' ? '识别中…' : '识别歌单'}
            </button>
          )}
        </div>
      </div>
    </Dialog>
  )
}

/** Desk sidebar section: imported playlists of this device + an 导入 button. */
export function ImportedPlaylistsNav({
  activeId,
  onOpen,
  onImport,
}: {
  activeId?: number
  onOpen: (p: ImportedPlaylist) => void
  onImport: () => void
}) {
  const list = useImportedPlaylists()
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between pr-1 pl-3 pb-1">
        <span className="text-xs tracking-[0.12em] text-subtle">临时歌单</span>
        <button
          type="button"
          onClick={onImport}
          title="导入网易云歌单到本设备"
          className="flex h-8 items-center gap-1 rounded-lg px-2 text-xs whitespace-nowrap text-fg-2 hover:bg-white/6 hover:text-fg"
        >
          <Icon name="plus" size={14} />
          导入
        </button>
      </div>
      {list.length === 0 ? (
        <p className="m-0 px-3 text-[13px] leading-6 text-muted">导入的歌单只显示在这台设备</p>
      ) : (
        list.map((p) => (
          <div
            key={p.id}
            className={clsx(
              'group flex h-10 items-center gap-1 rounded-xl pr-1 transition-colors hover:bg-white/5',
              activeId === p.id && 'bg-white/7',
            )}
          >
            <button
              type="button"
              onClick={() => onOpen(p)}
              aria-current={activeId === p.id ? 'page' : undefined}
              className={clsx(
                'flex h-full min-w-0 flex-1 items-center gap-2.5 pl-3 text-left text-sm',
                activeId === p.id ? 'font-semibold text-fg' : 'text-[#B4B4BE]',
              )}
            >
              <Icon name="link" size={16} className={clsx('shrink-0', activeId === p.id && 'text-accent')} />
              <span className="truncate">{p.name}</span>
            </button>
            <button
              type="button"
              onClick={() => {
                removeImportedPlaylist(p.id)
                toast(`已移除「${p.name}」`)
              }}
              aria-label={`移除临时歌单 ${p.name}`}
              title="从本设备移除"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted opacity-0 group-hover:opacity-100 hover:bg-white/10 hover:text-fg focus-visible:opacity-100"
            >
              <Icon name="x" size={14} />
            </button>
          </div>
        ))
      )}
    </div>
  )
}

/** Horizontal chips (phone / narrow desk): imported playlists + an 导入歌单 chip. */
export function ImportedPlaylistChips({
  activeId,
  onOpen,
  onImport,
  className,
}: {
  activeId?: number
  onOpen: (p: ImportedPlaylist) => void
  onImport: () => void
  className?: string
}) {
  const list = useImportedPlaylists()
  return (
    <div className={clsx('-mx-1 flex gap-2 overflow-x-auto px-1 pb-0.5', className)}>
      <button
        type="button"
        onClick={onImport}
        className="flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-dashed border-white/20 px-3.5 text-sm whitespace-nowrap text-fg-2"
      >
        <Icon name="plus" size={14} />
        导入歌单
      </button>
      {list.map((p) => (
        <button
          key={p.id}
          type="button"
          onClick={() => onOpen(p)}
          className={clsx(
            'flex h-9 max-w-[200px] shrink-0 items-center gap-1.5 rounded-full border px-3.5 text-sm whitespace-nowrap',
            activeId === p.id ? 'border-fg bg-fg text-ink' : 'border-white/12 text-fg-2',
          )}
        >
          <Icon name="link" size={14} className="shrink-0" />
          <span className="truncate">{p.name}</span>
        </button>
      ))}
    </div>
  )
}
