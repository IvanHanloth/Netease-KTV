import { useEffect, useId, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import clsx from 'clsx'
import { api } from '../../lib/api'
import { useDebounced } from '../../lib/hooks'
import { separatorPhase, SEPARATOR_LABEL } from '../../lib/separator'
import { useApp } from '../../store/app'
import { Icon } from '../../components/icons'

/** 点歌台 search box (with suggestions) and the separator status chip next to it. */

export function SearchBox({ initial, onSearch }: { initial: string; onSearch: (q: string) => void }) {
  const [value, setValue] = useState(initial)
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const inputRef = useRef<HTMLInputElement>(null)
  const listId = useId()
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
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={items.length > 0 && active >= 0 && items[active] ? `${listId}-${active}` : undefined}
          onChange={(e) => {
            setValue(e.target.value)
            setOpen(true)
            setActive(-1)
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.keyCode === 229) return // confirming an IME candidate
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
          id={listId}
          role="listbox"
          aria-label="搜索建议"
          className="absolute border border-white/10 bg-[#17171F] inset-x-0 top-[58px] z-30 m-0 list-none overflow-hidden rounded-2xl p-1.5 shadow-[0_20px_50px_rgba(0,0,0,0.5)]"
        >
          {items.map((k, i) => (
            <li
              key={k}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => submit(k)}
              className={clsx(
                'flex h-10 w-full cursor-pointer items-center gap-3 rounded-xl px-3 text-left text-sm',
                i === active ? 'bg-white/10' : 'hover:bg-white/6',
              )}
            >
              <Icon name="search" size={15} className="text-subtle" />
              {k}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** Compact status dot next to the search box; click for the separation service details. */
export function SeparatorChip() {
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

  const state = separatorPhase(sep, connected)
  const label = SEPARATOR_LABEL[state]
  const color = state === 'ready' ? '#4ADE80' : state === 'preparing' || state === 'unconfigured' ? '#FBBF24' : '#8E8E99'

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
          {state === 'unconfigured' && (
            <p className="m-0 mt-3 text-xs leading-5 text-muted">还没有配置分离服务器，歌曲会以原曲播放。可在后台管理（/admin）里添加。</p>
          )}
        </div>
      )}
    </div>
  )
}
