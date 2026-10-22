import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import clsx from 'clsx'
import type { QueueItem } from '@shared/types'
import { api } from '../lib/api'
import { artistsText, fmtTime, queueStatusText } from '../lib/format'
import { errorText, toast, useStatusOf } from '../lib/hooks'
import { livePosition, useApp } from '../store/app'
import { Icon } from './icons'
import { Cover, dotColor, EmptyNote, Eq, IconButton, ProgressBar } from './ui'

export function useNow(interval = 1000) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), interval)
    return () => clearInterval(t)
  }, [interval])
  return now
}

async function safe(fn: () => Promise<unknown>) {
  try {
    await fn()
  } catch (e) {
    toast(errorText(e), 'error')
  }
}

export function NowSingingCard({ compact }: { compact?: boolean }) {
  const player = useApp((s) => s.state.player)
  const now = useNow(1000)
  const cur = player.current
  if (!cur)
    return (
      <div className="rounded-[20px] border border-dashed border-white/12 p-5 text-center text-sm text-muted">
        还没有在唱的歌，点一首开始吧
      </div>
    )
  const pos = livePosition(player, now)
  const dur = cur.song.duration / 1000
  return (
    <div className="relative overflow-hidden rounded-[20px] border border-white/10 bg-[linear-gradient(135deg,rgba(255,77,126,0.22)_0%,rgba(123,47,247,0.18)_100%)] p-4">
      <div className="flex items-center gap-3.5">
        <Cover song={cur.song} px={160} className={clsx('rounded-[14px]', compact ? 'h-14 w-14' : 'h-[60px] w-[60px]')} />
        <div className="flex min-w-0 flex-col gap-1">
          <span className="flex items-center gap-2 text-xs tracking-[0.12em] text-[#FFC2D1]">
            {player.playing && <Eq color="#FFC2D1" />}
            {player.playing ? '正在演唱' : '已暂停'}
          </span>
          <span className="truncate text-[17px] font-bold">{cur.song.name}</span>
          <span className="truncate text-[13px] text-fg-2">{artistsText(cur.song)}</span>
        </div>
      </div>
      <div className="num mt-3.5 flex items-center gap-2.5 text-xs text-fg-2">
        <span>{fmtTime(pos)}</span>
        <ProgressBar value={dur ? pos / dur : 0} color="#FFFFFF" className="flex-1 bg-white/18" />
        <span>{fmtTime(dur)}</span>
      </div>
    </div>
  )
}

function QueueRow({ item, index }: { item: QueueItem; index: number }) {
  const statusOf = useStatusOf()
  const st = statusOf(item.song)
  const busy = st.kind === 'proc' || st.kind === 'download'
  return (
    <motion.li
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, x: 24 }}
      transition={{ duration: 0.2 }}
      className="group flex items-center gap-3 rounded-[14px] px-2 py-2.5 hover:bg-white/4"
    >
      <span className="num w-5 shrink-0 text-center text-xs text-faint">{index + 1}</span>
      <Cover song={item.song} px={100} className="h-[42px] w-[42px] rounded-[10px]" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="truncate text-sm font-semibold">{item.song.name}</span>
        {busy ? (
          <div className="flex items-center gap-2 text-xs text-warn">
            <ProgressBar value={st.progress ?? 0} className="max-w-[120px] flex-1" />
            <span className="whitespace-nowrap">{st.label}</span>
          </div>
        ) : (
          <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted">
            <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: dotColor[st.kind] }} />
            <span className="truncate">
              {artistsText(item.song)} · {queueStatusText(st)}
            </span>
          </span>
        )}
      </div>
      {st.kind === 'error' && (
        <IconButton icon="refresh" label={`重试 ${item.song.name}`} size={34} iconSize={16} onClick={() => safe(() => api.retryTrack(item.song.id))} />
      )}
      <IconButton
        icon="top"
        label={`置顶 ${item.song.name}`}
        size={34}
        iconSize={17}
        disabled={index === 0}
        onClick={() => safe(() => api.queueTop(item.uid))}
      />
      <IconButton icon="x" label={`删除 ${item.song.name}`} size={34} iconSize={16} onClick={() => safe(() => api.queueRemove(item.uid))} />
    </motion.li>
  )
}

export function QueueList() {
  const queue = useApp((s) => s.state.queue)
  if (!queue.length) return <EmptyNote>队列是空的，从曲库挑一首吧</EmptyNote>
  return (
    <ol className="m-0 flex list-none flex-col gap-1 p-0">
      <AnimatePresence initial={false}>
        {queue.map((item, i) => (
          <QueueRow key={item.uid} item={item} index={i} />
        ))}
      </AnimatePresence>
    </ol>
  )
}

export function SeparatorCard() {
  const sep = useApp((s) => s.state.separator)
  return (
    <div className="flex flex-col gap-3 rounded-[18px] border border-white/7 bg-white/4 p-4">
      <div className="flex items-center gap-2.5">
        <Icon name="sparkle" size={18} className="text-accent" />
        <span className="text-sm font-semibold">AI 伴奏分离</span>
        <span
          className={clsx(
            'ml-auto inline-flex items-center gap-1.5 text-xs',
            sep.online ? 'text-ok' : 'text-muted',
          )}
        >
          <span
            aria-hidden="true"
            className="h-1.5 w-1.5 rounded-full"
            style={{ background: sep.online ? '#4ADE80' : '#8E8E99', boxShadow: sep.online ? '0 0 8px #4ADE80' : undefined }}
          />
          {sep.online ? '在线' : '离线'}
        </span>
      </div>
      <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3.5 gap-y-1.5 text-[13px]">
        <dt className="text-muted">模型</dt>
        <dd className="m-0 truncate text-right" title={sep.model}>
          {sep.model || '—'}
        </dd>
        <dt className="text-muted">设备</dt>
        <dd className="m-0 truncate text-right">{sep.device || '—'}</dd>
        <dt className="text-muted">队列</dt>
        <dd className="m-0 text-right">{sep.pending} 首待处理</dd>
      </dl>
      {!sep.online && <p className="m-0 text-xs leading-5 text-muted">分离服务未连接时，歌曲会以原曲播放。</p>}
    </div>
  )
}

export function QueuePanel() {
  const queue = useApp((s) => s.state.queue)
  const current = useApp((s) => s.state.player.current)
  return (
    <div className="flex h-full flex-col gap-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <h2 className="m-0 text-xl font-bold">已点歌曲</h2>
          <span className="num inline-flex h-6 min-w-6 items-center justify-center rounded-full bg-accent px-2 text-[13px] font-semibold text-accent-ink">
            {queue.length + (current ? 1 : 0)}
          </span>
        </div>
        <button
          type="button"
          disabled={!queue.length}
          onClick={() => safe(() => api.queueClear())}
          className="h-11 px-1 text-sm text-muted hover:text-fg disabled:opacity-40"
        >
          清空
        </button>
      </div>
      <NowSingingCard />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <QueueList />
      </div>
      <SeparatorCard />
    </div>
  )
}
