import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import type { ScoreEntry, SongRanking } from '@shared/types'
import { api } from '../lib/api'
import { artistsText } from '../lib/format'
import { errorText, toast } from '../lib/hooks'
import { useApp } from '../store/app'
import { Icon } from './icons'
import { Cover, Dialog, EmptyNote, Spinner } from './ui'

/** GET /api/scores, refetched whenever the server announces a leaderboard change. */
export function useLeaderboard() {
  const qc = useQueryClient()
  const version = useApp((s) => s.scoresVersion)
  useEffect(() => {
    if (version) void qc.invalidateQueries({ queryKey: ['scores'] })
  }, [version, qc])
  return useQuery({ queryKey: ['scores'], queryFn: api.scores, staleTime: 30_000 })
}

const MEDAL = ['#FFB547', '#D4D4DC', '#E08A5B']

function Medal({ rank, size = 28 }: { rank: number; size?: number }) {
  const color = MEDAL[rank - 1]
  return (
    <span
      className={clsx(
        'num inline-flex shrink-0 items-center justify-center rounded-full text-[13px] font-bold',
        color ? 'text-ink' : 'bg-white/8 text-muted',
      )}
      style={{ width: size, height: size, background: color }}
      aria-label={`第 ${rank} 名`}
    >
      {rank}
    </span>
  )
}

const fmtDate = (at: number) => {
  const d = new Date(at)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  busy,
  onConfirm,
  onClose,
}: {
  open: boolean
  title: string
  message: string
  confirmLabel: string
  busy?: boolean
  onConfirm: () => void
  onClose: () => void
}) {
  return (
    <Dialog open={open} onClose={onClose} title={title} width={420}>
      <p className="m-0 mb-6 text-[15px] leading-7 text-fg-2">{message}</p>
      <div className="flex justify-end gap-3">
        <button type="button" onClick={onClose} className="h-11 rounded-xl bg-white/8 px-5 text-sm whitespace-nowrap hover:bg-white/12">
          取消
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={busy}
          className="flex h-11 items-center gap-2 rounded-xl bg-[#F87171] px-5 text-sm font-bold whitespace-nowrap text-ink disabled:opacity-60"
        >
          {busy && <Spinner size={16} />}
          {confirmLabel}
        </button>
      </div>
    </Dialog>
  )
}

function EntryRow({ e, rank }: { e: ScoreEntry; rank: number }) {
  return (
    <li className="flex items-center gap-3 rounded-xl px-2 py-2 hover:bg-white/4">
      <Medal rank={rank} size={26} />
      <span className="num w-12 shrink-0 text-lg font-bold">{Math.round(e.score)}</span>
      <span className="min-w-0 flex-1 truncate text-sm">{e.singer || <span className="text-muted">匿名歌手</span>}</span>
      <span className="num hidden shrink-0 text-xs text-muted sm:inline">±{e.tolerance.toFixed(1)}</span>
      <span className="num shrink-0 text-xs whitespace-nowrap text-muted">{fmtDate(e.at)}</span>
    </li>
  )
}

function SongRow({
  r,
  index,
  manage,
  onReset,
}: {
  r: SongRanking
  index: number
  manage: boolean
  onReset: (r: SongRanking) => void
}) {
  const [open, setOpen] = useState(index === 0)
  return (
    <li className="rounded-2xl border border-white/6 bg-white/[0.025]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-3 rounded-2xl p-3 text-left hover:bg-white/4 sm:gap-4"
      >
        <span className="num w-6 shrink-0 text-center text-sm text-faint">{index + 1}</span>
        <Cover song={r.song} px={120} className="h-12 w-12 shrink-0 rounded-xl" />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-[15px] font-semibold">{r.song.name}</span>
          <span className="truncate text-[13px] text-muted">{artistsText(r.song)}</span>
        </span>
        <span className="hidden shrink-0 flex-col items-end gap-0.5 text-xs whitespace-nowrap text-muted sm:flex">
          <span>{r.plays} 次演唱</span>
          <span>平均 {Math.round(r.average)}</span>
        </span>
        <span className="flex w-16 shrink-0 flex-col items-end">
          <span className="num text-[26px] leading-none font-black text-accent">{Math.round(r.best)}</span>
          <span className="text-[11px] whitespace-nowrap text-muted">最高分</span>
        </span>
        <Icon name="chevronLeft" size={18} className={clsx('shrink-0 text-muted transition-transform', open ? 'rotate-90' : '-rotate-90')} />
      </button>
      {open && (
        <div className="px-3 pb-3">
          <ol className="m-0 flex list-none flex-col p-0">
            {r.entries.map((e, i) => (
              <EntryRow key={e.id} e={e} rank={i + 1} />
            ))}
          </ol>
          {manage && (
            <div className="mt-2 flex justify-end">
              <button
                type="button"
                onClick={() => onReset(r)}
                className="flex h-9 items-center gap-1.5 rounded-lg px-3 text-[13px] whitespace-nowrap text-muted hover:bg-white/8 hover:text-fg"
              >
                <Icon name="trash" size={15} />
                重置本曲
              </button>
            </div>
          )}
        </div>
      )}
    </li>
  )
}

/**
 * K 歌排行: every scored song, best score first, expandable to its top performances.
 * `manage` adds the reset buttons (desk only).
 */
export function Leaderboard({ manage = false }: { manage?: boolean }) {
  const { data, isLoading, isError } = useLeaderboard()
  const qc = useQueryClient()
  const [confirm, setConfirm] = useState<{ song?: SongRanking } | null>(null)
  const reset = useMutation({
    mutationFn: (songId?: number) => (songId === undefined ? api.resetScores() : api.resetSongScores(songId)),
    onSuccess: (_d, songId) => {
      toast(songId === undefined ? '排行榜已重置' : '已重置这首歌的成绩')
      setConfirm(null)
      void qc.invalidateQueries({ queryKey: ['scores'] })
    },
    onError: (e) => toast(errorText(e), 'error'),
  })

  const songs = data?.songs ?? []
  return (
    <div className="flex flex-col gap-4">
      {manage && songs.length > 0 && (
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm text-muted">共 {songs.length} 首歌有成绩</span>
          <button
            type="button"
            onClick={() => setConfirm({})}
            className="flex h-9 items-center gap-1.5 rounded-lg border border-white/10 px-3 text-[13px] whitespace-nowrap text-fg-2 hover:bg-white/8"
          >
            <Icon name="trash" size={15} />
            重置排行榜
          </button>
        </div>
      )}
      {isLoading ? (
        <div className="flex justify-center py-10 text-muted">
          <Spinner />
        </div>
      ) : isError ? (
        <EmptyNote>排行榜加载失败</EmptyNote>
      ) : songs.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-12 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-full bg-white/6 text-muted">
            <Icon name="trophy" size={26} />
          </span>
          <p className="m-0 text-[15px] font-semibold">还没有成绩</p>
          <p className="m-0 max-w-[320px] text-[13px] leading-6 text-muted">在主屏打开“评分”唱完一首歌，成绩就会出现在这里。</p>
        </div>
      ) : (
        <ol className="m-0 flex list-none flex-col gap-2.5 p-0">
          {songs.map((r, i) => (
            <SongRow key={r.song.id} r={r} index={i} manage={manage} onReset={(song) => setConfirm({ song })} />
          ))}
        </ol>
      )}
      <ConfirmDialog
        open={!!confirm}
        title={confirm?.song ? '重置这首歌的成绩？' : '重置整个排行榜？'}
        message={
          confirm?.song
            ? `《${confirm.song.song.name}》的 ${confirm.song.plays} 条成绩会被删除，无法恢复。`
            : '所有歌曲的成绩都会被删除，无法恢复。'
        }
        confirmLabel="重置"
        busy={reset.isPending}
        onConfirm={() => reset.mutate(confirm?.song?.song.id)}
        onClose={() => setConfirm(null)}
      />
    </div>
  )
}
