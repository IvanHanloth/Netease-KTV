import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import clsx from 'clsx'
import type { QueueItem } from '@shared/types'
import { api } from '../lib/api'
import { artistsText, fmtTime, queueStatusText } from '../lib/format'
import { errorText, runAction, shuffleQueue, toast, useIsPending, useSettings, useStatusOf } from '../lib/hooks'
import { useDragReorder } from '../lib/useDragReorder'
import { livePosition, sendCommand, useApp } from '../store/app'
import { Icon } from './icons'
import { DisplayModeButton, VocalModeButton } from './PlayerModes'
import { IdleVolumeControl } from './IdleVolume'
import { MicControls } from './MicControls'
import { ConfirmDialog, Cover, dotColor, EmptyNote, Eq, IconButton, ProgressBar } from './ui'

export function useNow(interval = 1000) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), interval)
    return () => clearInterval(t)
  }, [interval])
  return now
}

/** Queue / track operations: error toast with 重试 on network failures, de-duplicated while in flight. */
const safe = (key: string, fn: () => Promise<unknown>) => runAction(key, fn)

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
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex items-center gap-2 text-xs tracking-[0.12em] text-[#FFC2D1]">
            {player.playing && <Eq color="#FFC2D1" />}
            {player.playing ? '正在演唱' : '已暂停'}
          </span>
          <span className="truncate text-[17px] font-bold">{cur.song.name}</span>
          <span className="truncate text-[13px] text-fg-2">
            {artistsText(cur.song)}
            {cur.addedBy && <span className="text-muted"> · {cur.addedBy}</span>}
          </span>
        </div>
        {!compact && (
          <div className="flex shrink-0 items-center gap-1">
            <IconButton
              icon={player.playing ? 'pause' : 'play'}
              label={player.playing ? '暂停' : '播放'}
              onClick={() => sendCommand({ action: 'toggle' })}
              className="bg-white/10 text-fg"
            />
            <IconButton icon="next" label="切歌" onClick={() => sendCommand({ action: 'next' })} className="bg-white/10 text-fg" />
          </div>
        )}
      </div>
      <div className="num mt-3.5 flex items-center gap-2.5 text-xs text-fg-2">
        <span>{fmtTime(pos)}</span>
        <ProgressBar value={dur ? pos / dur : 0} color="#FFFFFF" className="flex-1 bg-white/18" />
        <span>{fmtTime(dur)}</span>
      </div>
      {!compact && (
        <div className="mt-3.5 grid grid-cols-2 gap-2">
          <VocalModeButton />
          <DisplayModeButton />
        </div>
      )}
    </div>
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
      animate={{ opacity: 1, y: 0, scale: dragging ? 1.02 : 1 }}
      exit={{ opacity: 0, x: 24 }}
      transition={{ duration: 0.2 }}
      className={clsx(
        'group relative flex items-center gap-2 rounded-[14px] px-1.5 py-2.5',
        dragging
          ? 'z-10 bg-white/10 shadow-[0_14px_34px_rgba(0,0,0,0.45)] ring-1 ring-white/15'
          : 'hover:bg-white/4',
      )}
    >
      <button
        type="button"
        {...handle}
        aria-label={`拖动排序 ${item.song.name}（方向键上下移动）`}
        title="拖动排序"
        className={clsx(
          'flex h-10 w-7 shrink-0 cursor-grab items-center justify-center rounded-lg text-faint hover:text-fg-2 focus-visible:text-fg',
          dragging && 'cursor-grabbing text-fg',
        )}
      >
        <Icon name="grip" size={16} />
      </button>
      <span className="num w-4 shrink-0 text-center text-xs text-faint">{index + 1}</span>
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
              {item.addedBy && <span className="text-subtle"> · 由 {item.addedBy} 点歌</span>}
            </span>
          </span>
        )}
      </div>
      {st.kind === 'error' && (
        <IconButton icon="refresh" label={`重试 ${item.song.name}`} size={34} iconSize={16} onClick={() => safe(`track:retry:${item.song.id}`, () => api.retryTrack(item.song.id))} />
      )}
      <IconButton
        icon="top"
        label={`置顶 ${item.song.name}`}
        size={34}
        iconSize={17}
        disabled={index === 0}
        onClick={() => safe(`queue:top:${item.uid}`, () => api.queueTop(item.uid))}
      />
      <IconButton icon="x" label={`删除 ${item.song.name}`} size={34} iconSize={16} onClick={() => safe(`queue:remove:${item.uid}`, () => api.queueRemove(item.uid))} />
    </motion.li>
  )
}

const queueKey = (q: QueueItem) => q.uid
const commitOrder = (uids: string[]) => api.queueReorder(uids)
const reorderFailed = (e: unknown) => toast(`排序失败：${errorText(e)}`, 'error')

export function QueueList() {
  const queue = useApp((s) => s.state.queue)
  const { ordered, dragKey, rowRef, handleProps } = useDragReorder(queue, queueKey, commitOrder, reorderFailed)
  if (!queue.length) return <EmptyNote>后面还没有歌，从曲库挑一首吧</EmptyNote>
  return (
    <ol className={clsx('m-0 flex list-none flex-col gap-1 p-0', dragKey && 'select-none')}>
      <AnimatePresence initial={false}>
        {ordered.map((item, i) => (
          <QueueRow
            key={item.uid}
            item={item}
            index={i}
            dragging={dragKey === item.uid}
            rowRef={rowRef(item.uid)}
            handle={handleProps(item.uid)}
          />
        ))}
      </AnimatePresence>
    </ol>
  )
}

/** Shuffle the whole queue. Needs at least two songs to mean anything. */
export function ShuffleButton({ count, className }: { count: number; className?: string }) {
  const pending = useIsPending('queue:shuffle')
  return (
    <button
      type="button"
      disabled={count < 2 || pending}
      onClick={() => void shuffleQueue(count)}
      title="随机打乱已点列表"
      className={clsx(
        'flex h-11 items-center gap-1.5 rounded-xl px-2.5 text-sm whitespace-nowrap text-fg-2 transition-colors hover:bg-white/6 hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent',
        className,
      )}
    >
      <Icon name="shuffle" size={16} />
      随机
    </button>
  )
}

export function QueuePanel() {
  const queue = useApp((s) => s.state.queue)
  const current = useApp((s) => s.state.player.current)
  const [confirmClear, setConfirmClear] = useState(false)
  const clearing = useIsPending('queue:clear')
  const empty = !current && !queue.length
  const idleOn = useSettings().data?.idleEnabled ?? false
  return (
    <div className="flex h-full flex-col gap-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <h2 className="m-0 text-xl font-bold">已点歌曲</h2>
          <span className="num inline-flex h-6 min-w-6 items-center justify-center rounded-full bg-accent px-2 text-[13px] font-semibold text-accent-ink">
            {queue.length + (current ? 1 : 0)}
          </span>
        </div>
        <div className="flex items-center gap-1">
          {!empty && (
            <>
              <ShuffleButton count={queue.length} />
              <button
                type="button"
                disabled={!queue.length}
                onClick={() => setConfirmClear(true)}
                className="h-11 px-2 text-sm whitespace-nowrap text-muted hover:text-fg disabled:opacity-40"
              >
                清空
              </button>
            </>
          )}
        </div>
      </div>
      {empty ? (
        <>
          <div className="rounded-[20px] border border-dashed border-white/12 p-6 text-center text-sm leading-6 text-muted">
            还没有点歌
            <br />
            从左边的曲库挑一首，或者用手机扫大屏上的二维码点歌
          </div>
          {/* Nothing is playing: the 大屏 play 待机音乐, adjustable here. */}
          {idleOn && (
            <div className="rounded-[20px] border border-white/8 bg-white/[0.03] p-4">
              <IdleVolumeControl />
            </div>
          )}
        </>
      ) : (
        <>
          <NowSingingCard />
          <div className="min-h-0 flex-1 overflow-y-auto">
            <QueueList />
          </div>
        </>
      )}
      <div className="shrink-0 rounded-[20px] border border-white/8 bg-white/[0.03] p-4">
        <MicControls />
      </div>
      <ConfirmDialog
        open={confirmClear}
        title="清空已点列表？"
        message={`已点的 ${queue.length} 首歌会全部移除，正在唱的不受影响。`}
        confirmLabel="清空"
        busy={clearing}
        onConfirm={async () => {
          await safe('queue:clear', () => api.queueClear())
          setConfirmClear(false)
        }}
        onClose={() => setConfirmClear(false)}
      />
    </div>
  )
}
