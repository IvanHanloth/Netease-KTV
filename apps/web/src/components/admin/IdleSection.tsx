import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import clsx from 'clsx'
import type { AdminSettings, Song } from '@shared/types'
import { api } from '../../lib/api'
import { artistsText, fmtMs } from '../../lib/format'
import { useDebounced } from '../../lib/hooks'
import { Icon } from '../icons'
import { Cover, Range, Spinner, Switch } from '../ui'
import { Card, inputCls, Row } from './parts'

type SetFn = <K extends keyof AdminSettings>(k: K, v: AdminSettings[K]) => void

/** 待机音乐: what the TV plays quietly while nothing is queued (part of the admin draft). */
export function IdleSection({ draft, set }: { draft: AdminSettings; set: SetFn }) {
  const saved = useQuery({ queryKey: ['idle-music'], queryFn: api.idleMusic, staleTime: 30_000 })
  // Songs we know details for: the saved list plus anything added from search.
  const [added, setAdded] = useState<Map<number, Song>>(new Map())
  const known = useMemo(() => {
    const m = new Map<number, Song>()
    for (const s of saved.data?.songs ?? []) m.set(s.id, s)
    for (const [id, s] of added) m.set(id, s)
    return m
  }, [saved.data, added])
  const ids = draft.idleSongs
  const pct = Math.round(draft.idleVolume * 100)

  const move = (i: number, d: number) => {
    const j = i + d
    if (j < 0 || j >= ids.length) return
    const next = [...ids]
    ;[next[i], next[j]] = [next[j]!, next[i]!]
    set('idleSongs', next)
  }
  const add = (song: Song) => {
    if (ids.includes(song.id)) return
    setAdded((m) => new Map(m).set(song.id, song))
    set('idleSongs', [...ids, song.id])
  }

  return (
    <>
      <Card>
        <Row title="启用待机音乐" help="已点列表空了的时候，大屏显示扫码页面，主屏小声循环播放下面的歌。有人点歌就自动淡出。">
          <Switch checked={draft.idleEnabled} onChange={(v) => set('idleEnabled', v)} label="启用待机音乐" />
        </Row>
        <Row stack title="音量" help="相对于伴奏音量的比例；伴奏音量调大调小，待机音乐也跟着变。">
          <div className={clsx('flex items-center gap-4', !draft.idleEnabled && 'pointer-events-none opacity-45')}>
            <div className="flex-1">
              <Range label="待机音乐音量（%）" min={0} max={100} value={pct} onChange={(v) => set('idleVolume', v / 100)} color="#8B7BFF" />
            </div>
            <span className="num w-24 text-right text-sm text-fg-2">伴奏的 {pct}%</span>
          </div>
        </Row>
      </Card>

      <Card title={`播放列表 · ${ids.length} 首`}>
        {ids.length === 0 ? (
          <p className="m-0 rounded-2xl border border-dashed border-white/12 px-4 py-6 text-center text-sm text-muted">
            列表是空的，主屏待机时不会放歌。从下面搜索添加。
          </p>
        ) : (
          <ol className="m-0 flex list-none flex-col gap-1 p-0">
            {ids.map((id, i) => {
              const s = known.get(id)
              return (
                <li key={id} className="flex items-center gap-3 rounded-xl px-2 py-1.5 hover:bg-white/4">
                  <span className="num w-6 text-center text-xs text-subtle">{i + 1}</span>
                  {s ? (
                    <Cover song={s} px={80} className="h-10 w-10 rounded-lg" />
                  ) : (
                    <span className="h-10 w-10 rounded-lg bg-white/6" />
                  )}
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm font-semibold">{s ? s.name : `歌曲 ${id}`}</span>
                    <span className="truncate text-xs text-muted">{s ? `${artistsText(s)} · ${fmtMs(s.duration)}` : '读取中…'}</span>
                  </div>
                  <IconBtn icon="top" label="上移" onClick={() => move(i, -1)} disabled={i === 0} />
                  <IconBtn icon="top" label="下移" onClick={() => move(i, 1)} disabled={i === ids.length - 1} flip />
                  <IconBtn icon="trash" label="移除" onClick={() => set('idleSongs', ids.filter((x) => x !== id))} />
                </li>
              )
            })}
          </ol>
        )}
        <SongSearch onAdd={add} has={(id) => ids.includes(id)} />
      </Card>
    </>
  )
}

function IconBtn({
  icon,
  label,
  onClick,
  disabled,
  flip,
}: {
  icon: 'top' | 'trash'
  label: string
  onClick: () => void
  disabled?: boolean
  flip?: boolean
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-white/8 hover:text-fg disabled:opacity-25"
    >
      <Icon name={icon} size={15} className={flip ? 'rotate-180' : undefined} />
    </button>
  )
}

function SongSearch({ onAdd, has }: { onAdd: (s: Song) => void; has: (id: number) => boolean }) {
  const [q, setQ] = useState('')
  const term = useDebounced(q.trim(), 350)
  const results = useQuery({
    queryKey: ['search', term, 'idle'],
    queryFn: () => api.search(term, 0, 8),
    enabled: term.length > 0,
  })
  return (
    <div className="flex flex-col gap-2 border-t border-white/6 pt-4">
      <label className="relative flex items-center">
        <Icon name="search" size={16} className="pointer-events-none absolute left-3 text-muted" />
        <span className="sr-only-x">搜索要添加的歌</span>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="搜索歌曲添加到待机音乐"
          className={clsx(inputCls, 'pl-9')}
          type="search"
        />
      </label>
      {term &&
        (results.isLoading ? (
          <div className="flex justify-center py-4 text-muted">
            <Spinner size={18} />
          </div>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {(results.data?.songs ?? []).map((s) => {
              const inList = has(s.id)
              const blocked = s.playable === 'vip'
              return (
                <li key={s.id} className="flex items-center gap-3 rounded-xl px-2 py-1.5 hover:bg-white/4">
                  <Cover song={s} px={80} className="h-9 w-9 rounded-lg" />
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm">{s.name}</span>
                    <span className="truncate text-xs text-muted">{artistsText(s)}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => onAdd(s)}
                    disabled={inList || blocked}
                    className="flex h-8 shrink-0 items-center gap-1 rounded-lg bg-white/8 px-2.5 text-xs font-semibold text-fg-2 hover:bg-white/12 disabled:opacity-40"
                  >
                    {inList ? '已添加' : blocked ? '会员' : (
                      <>
                        <Icon name="plus" size={13} /> 添加
                      </>
                    )}
                  </button>
                </li>
              )
            })}
            {results.data && !results.data.songs.length && <li className="py-3 text-center text-sm text-muted">没有找到</li>}
          </ul>
        ))}
    </div>
  )
}
