import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import clsx from 'clsx'
import type { QueueItem } from '@shared/types'
import { api } from '../lib/api'
import { artistsText, fmtTime, queueStatusText } from '../lib/format'
import { errorText, runAction, shuffleQueue, toast, useIsPending, useSettings, useStatusOf } from '../lib/hooks'
import { useDragReorder } from '../lib/useDragReorder'
import { livePosition, sendCommand, useApp } from '../store/app'
import { Icon } from './icons'
import { IdleVolumeControl } from './IdleVolume'
import { ControlPanelLauncher } from './ControlPanel'
import { ConfirmDialog, Cover, dotColor, EmptyNote } from './ui'

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

type HandleProps = ReturnType<ReturnType<typeof useDragReorder<QueueItem>>['handleProps']>

const queueKey = (q: QueueItem) => q.uid
const commitOrder = (uids: string[]) => api.queueReorder(uids)
const reorderFailed = (e: unknown) => toast(`排序失败：${errorText(e)}`, 'error')

// ---------- 点歌台 已点 panel ----------

function DotsIcon() {
  return (
    <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24">
      <circle cx="5" cy="12" r="1.6" fill="currentColor" />
      <circle cx="12" cy="12" r="1.6" fill="currentColor" />
      <circle cx="19" cy="12" r="1.6" fill="currentColor" />
    </svg>
  )
}

type MenuItem = { label: string; onSelect: () => void; disabled?: boolean; danger?: boolean }

/**
 * ⋯ button with a small menu. The menu is fixed-positioned next to the button so the scrolling
 * queue list never clips it; it closes on outside click, Escape, scroll or resize.
 */
function MoreMenu({
  label,
  items,
  onOpenChange,
}: {
  label: string
  items: MenuItem[]
  onOpenChange?: (open: boolean) => void
}) {
  const btn = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; right: number; up: boolean } | null>(null)
  const open = !!pos
  const close = () => setPos(null)
  const openChange = useRef(onOpenChange)
  openChange.current = onOpenChange
  useEffect(() => openChange.current?.(open), [open])
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (!menu.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) close()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        close()
        btn.current?.focus()
      }
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', close)
    window.addEventListener('scroll', close, true)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [open])
  useLayoutEffect(() => {
    if (open) menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
  }, [open])
  const toggle = () => {
    if (open) return close()
    const r = btn.current!.getBoundingClientRect()
    // Open upwards when there is no room below (the last rows, just above the 控制台 button).
    const up = window.innerHeight - r.bottom < items.length * 40 + 24
    setPos({ top: up ? r.top - 6 : r.bottom + 6, right: window.innerWidth - r.right, up })
  }
  return (
    <>
      <button
        ref={btn}
        type="button"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggle}
        className={clsx(
          'flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] text-muted transition-colors hover:bg-white/8 hover:text-fg',
          open && 'bg-white/8 text-fg',
        )}
      >
        <DotsIcon />
      </button>
      {pos && (
        <div
          ref={menu}
          role="menu"
          aria-label={label}
          className="fixed z-50 flex min-w-[148px] flex-col rounded-[14px] bg-[#2A2A35] p-1.5 shadow-[0_16px_40px_rgba(0,0,0,0.5)]"
          style={{ right: pos.right, ...(pos.up ? { bottom: window.innerHeight - pos.top } : { top: pos.top }) }}
        >
          {items.map((it) => (
            <button
              key={it.label}
              type="button"
              role="menuitem"
              disabled={it.disabled}
              onClick={() => {
                close()
                it.onSelect()
              }}
              className={clsx(
                'h-10 rounded-[9px] px-3 text-left text-sm whitespace-nowrap transition-colors hover:bg-white/8 focus-visible:bg-white/8 focus-visible:outline-none disabled:opacity-40 disabled:hover:bg-transparent',
                it.danger ? 'text-[#FF8FAB]' : 'text-fg',
              )}
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
    </>
  )
}

function RoundBtn({
  label,
  onClick,
  disabled,
  primary,
  children,
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  primary?: boolean
  children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className={clsx(
        'flex shrink-0 items-center justify-center rounded-full transition-colors disabled:opacity-40',
        primary ? 'h-14 w-14 bg-accent text-accent-ink hover:brightness-110' : 'h-11 w-11 text-fg-2 hover:bg-white/8 hover:text-fg',
      )}
    >
      {children}
    </button>
  )
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v))

/**
 * 正在演唱 progress: click or drag to seek the 大屏. While dragging the bar follows the pointer
 * and the seek is sent on release; the new spot is held until the 大屏 reports it back, so the
 * bar does not flick back to the old position in between. Arrow keys step 5 s.
 */
function SeekBar({ position, duration, positionAt }: { position: number; duration: number; positionAt?: number }) {
  const track = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<number | null>(null)
  const [held, setHeld] = useState<number | null>(null)
  // The 大屏 reported a new position: drop the held value.
  useEffect(() => setHeld(null), [positionAt])
  useEffect(() => {
    if (held === null) return
    const t = setTimeout(() => setHeld(null), 2000)
    return () => clearTimeout(t)
  }, [held])
  const can = duration > 0
  const shown = drag ?? held ?? Math.min(position, duration)
  const pct = can ? clamp01(shown / duration) * 100 : 0
  const at = (clientX: number) => {
    const r = track.current!.getBoundingClientRect()
    return clamp01((clientX - r.left) / r.width) * duration
  }
  const seek = (sec: number) => {
    const s = Math.max(0, Math.min(duration - 0.5, sec))
    setHeld(s)
    sendCommand({ action: 'seek', position: s })
  }
  return (
    <div className="flex flex-col gap-1">
      <div
        ref={track}
        role="slider"
        tabIndex={can ? 0 : -1}
        aria-label="播放进度"
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={Math.round(shown)}
        aria-valuetext={`${fmtTime(shown)} / ${fmtTime(duration)}`}
        aria-disabled={!can}
        onPointerDown={(e) => {
          if (!can || e.button !== 0) return
          e.currentTarget.setPointerCapture(e.pointerId)
          setDrag(at(e.clientX))
        }}
        onPointerMove={(e) => {
          if (drag !== null) setDrag(at(e.clientX))
        }}
        onPointerUp={(e) => {
          if (drag === null) return
          seek(at(e.clientX))
          setDrag(null)
        }}
        onPointerCancel={() => setDrag(null)}
        onKeyDown={(e) => {
          if (!can) return
          const step = { ArrowLeft: -5, ArrowDown: -5, ArrowRight: 5, ArrowUp: 5 }[e.key]
          if (step !== undefined) seek(shown + step)
          else if (e.key === 'Home') seek(0)
          else return
          e.preventDefault()
        }}
        className={clsx(
          'group relative flex h-4 touch-none items-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-accent/60 [@media(pointer:coarse)]:h-7',
          can ? 'cursor-pointer' : 'cursor-default',
        )}
      >
        <div
          className={clsx(
            'relative h-[3px] w-full rounded-full bg-white/10 transition-[height] group-hover:h-[5px]',
            drag !== null && 'h-[5px]',
          )}
        >
          <div className="absolute inset-y-0 left-0 rounded-full bg-[#FF4D7E]" style={{ width: `${pct}%` }} />
        </div>
        <div
          aria-hidden="true"
          className={clsx(
            'pointer-events-none absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-[0_2px_8px_rgba(0,0,0,0.45)] transition-opacity',
            drag !== null ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 [@media(pointer:coarse)]:opacity-100',
          )}
          style={{ left: `${pct}%` }}
        />
      </div>
      <div className="num flex justify-between text-[11px] text-muted">
        <span className={clsx(drag !== null && 'text-fg')}>{fmtTime(shown)}</span>
        <span>{fmtTime(duration)}</span>
      </div>
    </div>
  )
}

/** 正在演唱: cover, title, a draggable progress bar and the three transport buttons. */
function DeskNowCard() {
  const player = useApp((s) => s.state.player)
  const now = useNow(1000)
  const cur = player.current
  if (!cur) return null
  const pos = livePosition(player, now)
  const dur = cur.song.duration / 1000
  return (
    <section aria-label="正在演唱" className="flex shrink-0 flex-col gap-4 rounded-[22px] bg-[#16161E] p-[18px]">
      <div className="flex items-center gap-3.5">
        <Cover song={cur.song} px={160} className="h-14 w-14 rounded-[14px]" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-xs text-[#FF8FAB]">{player.playing ? '正在演唱' : '已暂停'}</span>
          <span className="truncate text-lg font-extrabold">{cur.song.name}</span>
          <span className="truncate text-[13px] text-muted">{artistsText(cur.song)}</span>
        </div>
      </div>
      <SeekBar position={pos} duration={dur} positionAt={player.positionAt} />
      <div className="-mt-1 flex items-center justify-center gap-5">
        <RoundBtn label="重唱" onClick={() => sendCommand({ action: 'restart' })}>
          <Icon name="replay" size={19} />
        </RoundBtn>
        <RoundBtn primary label={player.playing ? '暂停' : '播放'} onClick={() => sendCommand({ action: 'toggle' })}>
          <Icon name={player.playing ? 'pause' : 'play'} size={22} />
        </RoundBtn>
        <RoundBtn label="切歌" onClick={() => sendCommand({ action: 'next' })}>
          <Icon name="next" size={19} />
        </RoundBtn>
      </div>
    </section>
  )
}

/**
 * One 接下来 row. With a mouse the whole row drags to reorder (no grip); on touch the list scrolls
 * normally and 置顶 is in the ⋯ menu. A focused row moves with the arrow keys. The status line only
 * shows while the song is still being prepared, or when it failed.
 */
function DeskQueueRow({
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
  const failed = st.kind === 'error'
  const [menuOpen, setMenuOpen] = useState(false)
  const { onPointerDown, onKeyDown } = handle
  const items: MenuItem[] = [
    ...(failed
      ? [{ label: '重试', onSelect: () => void safe(`track:retry:${item.song.id}`, () => api.retryTrack(item.song.id)) }]
      : []),
    { label: '置顶', disabled: index === 0, onSelect: () => void safe(`queue:top:${item.uid}`, () => api.queueTop(item.uid)) },
    { label: '删除', danger: true, onSelect: () => void safe(`queue:remove:${item.uid}`, () => api.queueRemove(item.uid)) },
  ]
  return (
    <motion.li
      ref={rowRef}
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0, scale: dragging ? 1.02 : 1 }}
      exit={{ opacity: 0, x: 24 }}
      transition={{ duration: 0.2 }}
      tabIndex={0}
      aria-roledescription="拖动排序"
      aria-label={`${item.song.name}，第 ${index + 1} 首（方向键上下移动）`}
      onPointerDown={(e) => {
        if (e.pointerType === 'touch' || (e.target as HTMLElement).closest('button')) return
        onPointerDown(e)
      }}
      onKeyDown={(e) => {
        if (e.target === e.currentTarget) onKeyDown(e)
      }}
      className={clsx(
        'group relative flex items-center gap-3 rounded-[14px] py-2 pr-1 pl-1.5 outline-none focus-visible:ring-2 focus-visible:ring-accent/60 [@media(pointer:fine)]:cursor-grab',
        dragging ? 'z-10 cursor-grabbing bg-white/10 shadow-[0_14px_34px_rgba(0,0,0,0.45)]' : 'hover:bg-white/4',
        menuOpen && 'bg-white/4',
      )}
    >
      <Cover song={item.song} px={100} className="h-10 w-10 rounded-[10px]" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-sm font-semibold">{item.song.name}</span>
        <span className="flex min-w-0 items-center gap-1.5 text-xs whitespace-nowrap text-muted">
          {(busy || failed) && (
            <>
              <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: dotColor[st.kind] }} />
              <span className={failed ? 'text-[#FF8FAB]' : 'text-[#FCD34D]'}>{busy ? st.label : queueStatusText(st)}</span>
              <span aria-hidden="true">·</span>
            </>
          )}
          <span className="truncate">{item.addedBy || artistsText(item.song)}</span>
        </span>
      </div>
      <div
        className={clsx(
          'transition-opacity',
          !menuOpen &&
            '[@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-focus-within:opacity-100 [@media(hover:hover)]:group-hover:opacity-100',
        )}
      >
        <MoreMenu label={`更多：${failed ? '重试、' : ''}置顶、删除`} items={items} onOpenChange={setMenuOpen} />
      </div>
    </motion.li>
  )
}

function DeskQueueList() {
  const queue = useApp((s) => s.state.queue)
  const { ordered, dragKey, rowRef, handleProps } = useDragReorder(queue, queueKey, commitOrder, reorderFailed)
  if (!queue.length) return <EmptyNote>后面还没有歌，从曲库挑一首吧</EmptyNote>
  return (
    <ol aria-label="接下来" className={clsx('m-0 flex list-none flex-col gap-1 p-0', dragKey && 'select-none')}>
      <AnimatePresence initial={false}>
        {ordered.map((item, i) => (
          <DeskQueueRow
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

function HeaderBtn({
  icon,
  label,
  title,
  onClick,
  disabled,
  danger,
}: {
  icon: 'shuffle' | 'trash'
  label: string
  title: string
  onClick: () => void
  disabled?: boolean
  danger?: boolean
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={clsx(
        'flex h-8 items-center gap-1.5 rounded-[10px] px-2.5 text-[13px] whitespace-nowrap transition-colors disabled:opacity-35 disabled:hover:bg-transparent',
        danger ? 'text-[#FF8FAB] hover:bg-[#FF4D7E]/12' : 'text-fg-2 hover:bg-white/8 hover:text-fg',
      )}
    >
      <Icon name={icon} size={15} />
      {label}
    </button>
  )
}

/** 点歌台 已点: count + 随机 / 清空, 正在演唱, 接下来, and the 控制台 entry at the bottom. */
export function QueuePanel() {
  const queue = useApp((s) => s.state.queue)
  const current = useApp((s) => s.state.player.current)
  const [confirmClear, setConfirmClear] = useState(false)
  const clearing = useIsPending('queue:clear')
  const shuffling = useIsPending('queue:shuffle')
  const empty = !current && !queue.length
  const idleOn = useSettings().data?.idleEnabled ?? false
  return (
    <div className="flex h-full flex-col gap-6">
      <div className="flex items-center justify-between pl-1">
        <h2 className="m-0 text-lg font-extrabold">
          已点 <span className="num font-semibold text-muted">{queue.length + (current ? 1 : 0)}</span>
        </h2>
        {!empty && (
          <div className="flex items-center gap-1">
            <HeaderBtn
              icon="shuffle"
              label="随机"
              title="随机打乱接下来的歌"
              disabled={queue.length < 2 || shuffling}
              onClick={() => void shuffleQueue(queue.length)}
            />
            <HeaderBtn
              icon="trash"
              label="清空"
              title="清空接下来的歌"
              danger
              disabled={!queue.length}
              onClick={() => setConfirmClear(true)}
            />
          </div>
        )}
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
          <DeskNowCard />
          <div className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1">
            <DeskQueueList />
          </div>
        </>
      )}
      {/* Everything the 大屏 control bar can do, and the 大屏 themselves. */}
      <div className="mt-auto shrink-0">
        <ControlPanelLauncher />
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
