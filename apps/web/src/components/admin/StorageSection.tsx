import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import type { AdminSettings, CacheGroup, CacheInfo, CachedSongInfo, CacheKind, DataCacheKind, MediaCacheKind, MvResolution } from '@shared/types'
import { MV_RESOLUTIONS } from '@shared/constants'
import { api, type CacheCleared } from '../../lib/api'
import { fmtAgo, fmtBytes } from '../../lib/format'
import { runAction, useCacheInfo, useCachedSongs, useIsPending } from '../../lib/hooks'
import { Icon } from '../icons'
import { ConfirmDialog, Cover, QueryError, Range, Spinner, Switch } from '../ui'
import { Card, Row, Segmented, type SetFn } from './parts'

/**
 * 视频与缓存: MV options, the cache limit (saved with the rest of the draft), and cache clearing
 * per kind, per song and for NetEase data (immediate, no save needed).
 */

const GB = 1024 ** 3
const RESOLUTIONS: readonly MvResolution[] = MV_RESOLUTIONS

const MEDIA: Record<MediaCacheKind, { label: string; note: string; color: string; costly?: string }> = {
  stems: {
    label: '伴奏与人声',
    note: 'AI 分离出的伴奏和人声。清除后这些歌再被点到时要重新分离，每首几分钟。',
    color: 'var(--color-violet)',
    costly: '清除后，这些歌再被点到时要重新分离伴奏，每首需要几分钟。',
  },
  pitched: { label: '变调音频', note: '升降调时生成，通常最占空间。清除后换调时重新生成，几秒钟。', color: 'var(--color-accent-soft)' },
  original: { label: '原曲音频', note: '下载的原曲。清除后用到时自动重新下载。', color: 'var(--color-info-dot)' },
  mv: { label: 'MV 视频', note: '下载的 MV。清除后播放 MV 时重新下载。', color: 'var(--color-warn-dot)' },
  analysis: { label: '评分音高与 MV 对齐', note: '很小。清除后，歌曲再被点到时自动重新计算。', color: 'var(--color-ok)' },
  temp: { label: '临时文件', note: '中断的下载和处理留下的文件，可以放心清除。', color: 'var(--color-faint)' },
}
const MEDIA_ORDER: MediaCacheKind[] = ['stems', 'pitched', 'original', 'mv', 'analysis', 'temp']

const DATA: Record<DataCacheKind, { label: string; note: string }> = {
  search: { label: '搜索与联想', note: '搜索结果和搜索建议' },
  library: { label: '歌单、专辑与歌手', note: '你的歌单列表、歌单内容、专辑和歌手页' },
  recommend: { label: '日推与榜单', note: '每日推荐和排行榜' },
  lyrics: { label: '歌词', note: '逐字歌词和翻译' },
  songs: { label: '歌曲信息', note: '歌名、封面和能否播放；清除只标记为过期，用到时重新获取' },
}

const KEEP: Record<NonNullable<CachedSongInfo['keep']>, string> = {
  playing: '正在唱',
  queued: '已点',
  'idle-music': '待机音乐',
  busy: '处理中',
}

const clearKey = (what: string) => `cache:clear:${what}`

/** Run a clear with feedback and put the server's fresh numbers in place. */
function useClear() {
  const qc = useQueryClient()
  return async (what: string, fn: () => Promise<CacheCleared>, ok: (r: CacheCleared) => string, refetchAll = false) => {
    const r = await runAction(clearKey(what), fn, ok)
    if (!r) return
    qc.setQueryData<CacheInfo>(['cache'], r.cache)
    void qc.invalidateQueries({ queryKey: ['cache', 'songs'] })
    // Lists and lyrics on this page come from the data cache too.
    if (refetchAll) void qc.invalidateQueries({ predicate: (q) => q.queryKey[0] !== 'cache' })
  }
}

const freedText = (r: CacheCleared) => (r.freed ? `已清除，释放 ${fmtBytes(r.freed)}` : '已清除')

export function StorageSection({ draft, set }: { draft: AdminSettings; set: SetFn }) {
  return (
    <>
      <Card title="MV">
        <Row title="预载 MV" help="提前下载已点歌曲的 MV：播放更流畅，并能自动和歌曲对齐。">
          <Switch checked={draft.mvPreload ?? true} onChange={(v) => set('mvPreload', v)} label="预载 MV" />
        </Row>
        <Row stack title="MV 清晰度" help="清晰度越高越占空间，网络慢时建议 720P 或 480P。">
          <Segmented
            label="MV 清晰度"
            value={draft.mvResolution ?? 720}
            onChange={(v) => set('mvResolution', v)}
            options={RESOLUTIONS.map((r) => ({ value: r, label: <span className="num">{r}P</span> }))}
          />
        </Row>
      </Card>
      <LimitCard draft={draft} set={set} />
      <MediaCard />
      <SongsCard />
      <DataCard />
    </>
  )
}

// ---------------- 缓存上限 ----------------

function LimitCard({ draft, set }: { draft: AdminSettings; set: SetFn }) {
  const cache = useCacheInfo()
  const limitGB = Math.round(draft.cacheLimitGB ?? 20)
  const [typed, setTyped] = useState<string | null>(null)
  const used = cache.data?.usedBytes ?? 0
  const ratio = Math.min(1, used / (limitGB * GB))
  const commit = (raw: string) => {
    const n = Math.round(Number(raw))
    if (Number.isFinite(n) && raw.trim() !== '') set('cacheLimitGB', Math.min(500, Math.max(1, n)))
    setTyped(null)
  }
  return (
    <Card title="缓存上限">
      <Row stack title="上限" help="超出时自动清理：先清临时文件和变调音频，再清最久没唱的歌。正在唱、已点和待机音乐里的歌不会被清理。保存后生效。">
        <div className="flex items-center gap-4">
          <div className="flex-1">
            <Range label="缓存上限（GB）" min={1} max={500} value={limitGB} onChange={(n) => set('cacheLimitGB', n)} color="#8B7BFF" />
          </div>
          <label className="flex items-center gap-1.5">
            <span className="sr-only-x">缓存上限（GB）</span>
            <input
              type="number"
              inputMode="numeric"
              min={1}
              max={500}
              step={1}
              value={typed ?? limitGB}
              onChange={(e) => setTyped(e.target.value)}
              onBlur={(e) => commit(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && commit(e.currentTarget.value)}
              className="num h-9 w-20 rounded-lg border border-white/10 bg-white/5 px-2 text-right text-sm text-fg outline-none focus:border-white/25"
            />
            <span className="text-sm text-muted">GB</span>
          </label>
        </div>
      </Row>
      {cache.isError && !cache.data ? (
        <QueryError compact error={cache.error} onRetry={() => cache.refetch()} retrying={cache.isFetching} />
      ) : (
        <div className="flex flex-col gap-3 rounded-2xl border border-white/8 bg-white/4 p-4">
          <div className="flex items-baseline justify-between gap-3">
            <span className="num text-xl font-bold">
              {cache.data ? fmtBytes(used) : '—'} <span className="text-sm font-medium text-muted">/ {limitGB} GB</span>
            </span>
            {cache.data && (
              <span className="num text-xs text-muted">
                {cache.data.songs} 首歌 · {cache.data.mvs} 个 MV
              </span>
            )}
          </div>
          <UsageBar groups={cache.data?.media} limit={limitGB * GB} warn={ratio > 0.9} />
          {cache.data && (
            <ul className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1.5 p-0 text-xs text-fg-2">
              {MEDIA_ORDER.map((kind) => {
                const g = cache.data.media.find((x) => x.kind === kind)
                if (!g?.bytes) return null
                return (
                  <li key={kind} className="flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-full" style={{ background: MEDIA[kind].color }} />
                    {MEDIA[kind].label} <span className="num text-muted">{fmtBytes(g.bytes)}</span>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}
    </Card>
  )
}

/** Media usage against the limit, one segment per kind. */
function UsageBar({ groups, limit, warn }: { groups?: CacheGroup[]; limit: number; warn: boolean }) {
  return (
    <div
      aria-hidden="true"
      className={clsx('flex h-2 overflow-hidden rounded-full bg-white/10', warn && 'ring-1 ring-warn-dot/60')}
    >
      {MEDIA_ORDER.map((kind) => {
        const g = groups?.find((x) => x.kind === kind)
        if (!g?.bytes) return null
        return (
          <div
            key={kind}
            className="h-full transition-[width] duration-500"
            style={{ width: `${Math.min(100, (g.bytes / limit) * 100)}%`, background: MEDIA[kind].color }}
          />
        )
      })}
    </div>
  )
}

// ---------------- 媒体缓存 (per kind) ----------------

function MediaCard() {
  const cache = useCacheInfo()
  const clear = useClear()
  const [confirm, setConfirm] = useState<MediaCacheKind | 'all' | null>(null)
  const allPending = useIsPending(clearKey('media'))

  const run = (what: MediaCacheKind | 'all') => {
    setConfirm(null)
    if (what === 'all') void clear('media', api.clearMediaCache, freedText)
    else void clear(what, () => api.clearCacheKind(what), freedText)
  }
  const ask = (what: MediaCacheKind | 'all') => {
    if (what === 'all' || MEDIA[what].costly) setConfirm(what)
    else run(what)
  }
  const clearableBytes = cache.data?.media.reduce((a, g) => a + g.bytes - g.protectedBytes, 0) ?? 0

  return (
    <Card
      title="音频与视频缓存"
      action={
        <ClearButton
          label="全部清除"
          pending={allPending}
          disabled={!clearableBytes}
          onClick={() => ask('all')}
        />
      }
    >
      <p className="m-0 -mt-2 text-xs leading-5 text-muted">清除立即生效，不需要保存。正在唱、已点和待机音乐里的歌会保留。</p>
      {cache.isLoading ? (
        <span className="flex items-center gap-2 text-xs text-muted">
          <Spinner size={13} /> 读取缓存…
        </span>
      ) : cache.isError && !cache.data ? (
        <QueryError compact error={cache.error} onRetry={() => cache.refetch()} retrying={cache.isFetching} />
      ) : (
        <ul className="m-0 flex list-none flex-col divide-y divide-white/6 p-0">
          {MEDIA_ORDER.map((kind) => (
            <KindRow
              key={kind}
              kind={kind}
              group={cache.data?.media.find((g) => g.kind === kind)}
              label={MEDIA[kind].label}
              note={MEDIA[kind].note}
              color={MEDIA[kind].color}
              unit="个文件"
              onClear={() => ask(kind)}
            />
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={confirm !== null}
        title={confirm === 'all' ? '清除全部音频与视频缓存？' : `清除${confirm ? MEDIA[confirm].label : ''}？`}
        message={
          confirm === 'all'
            ? '原曲、伴奏、变调音频和 MV 都会删除（正在唱、已点和待机音乐里的歌保留）。之后点到这些歌要重新下载和分离。'
            : (confirm && MEDIA[confirm].costly) || ''
        }
        confirmLabel="清除"
        onConfirm={() => confirm && run(confirm)}
        onClose={() => setConfirm(null)}
      />
    </Card>
  )
}

function KindRow({
  kind,
  group,
  label,
  note,
  color,
  unit,
  onClear,
}: {
  kind: CacheKind
  group?: CacheGroup
  label: string
  note: string
  color?: string
  unit: string
  onClear: () => void
}) {
  const pending = useIsPending(clearKey(kind))
  const bytes = group?.bytes ?? 0
  const kept = group?.protectedBytes ?? 0
  return (
    <li className="flex flex-col gap-2 py-3.5 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:gap-4">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        {color && <span className="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: color }} />}
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-[15px] font-semibold">{label}</span>
          <span className="text-xs leading-5 text-muted">{note}</span>
          {kept > 0 && <span className="text-xs leading-5 text-subtle">其中 {fmtBytes(kept)} 会保留</span>}
        </div>
      </div>
      <div className="flex items-center justify-between gap-4 pl-5.5 sm:justify-end sm:pl-0">
        <span className="num text-right text-sm text-fg-2">
          {fmtBytes(bytes)}
          <span className="block text-xs text-muted">
            {group?.count ?? 0} {unit}
          </span>
        </span>
        <ClearButton label="清除" pending={pending} disabled={bytes - kept <= 0} onClick={onClear} />
      </div>
    </li>
  )
}

function ClearButton({
  label,
  pending,
  disabled,
  onClick,
  danger,
}: {
  label: string
  pending?: boolean
  disabled?: boolean
  onClick: () => void
  danger?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || pending}
      className={clsx(
        'flex h-9 shrink-0 items-center gap-1.5 rounded-lg px-3 text-sm whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-45',
        danger ? 'bg-[rgba(255,77,126,0.14)] text-accent-soft hover:bg-[rgba(255,77,126,0.22)]' : 'bg-white/6 text-fg-2 hover:bg-white/10',
      )}
    >
      {pending ? <Spinner size={14} /> : <Icon name="trash" size={15} />}
      {label}
    </button>
  )
}

// ---------------- 缓存的歌曲 ----------------

const SHORT = { original: '原曲', stems: '伴奏', pitched: '变调', analysis: '分析', mv: 'MV', temp: '临时' } as const
const PREVIEW_COUNT = 8

function SongsCard() {
  const q = useCachedSongs()
  const [all, setAll] = useState(false)
  const [confirm, setConfirm] = useState<CachedSongInfo | null>(null)
  const clear = useClear()
  const songs = q.data?.songs ?? []
  const shown = all ? songs : songs.slice(0, PREVIEW_COUNT)
  const remove = (s: CachedSongInfo, kinds?: MediaCacheKind[]) => {
    setConfirm(null)
    void clear(`song:${s.songId}:${kinds?.join(',') ?? 'all'}`, () => api.clearSongCache(s.songId, kinds), freedText)
  }

  return (
    <Card title="缓存的歌曲">
      {q.isLoading ? (
        <span className="flex items-center gap-2 text-xs text-muted">
          <Spinner size={13} /> 读取缓存…
        </span>
      ) : q.isError && !q.data ? (
        <QueryError compact error={q.error} onRetry={() => q.refetch()} retrying={q.isFetching} />
      ) : !songs.length ? (
        <p className="m-0 text-sm text-muted">还没有缓存的歌曲。</p>
      ) : (
        <>
          <p className="m-0 -mt-2 text-xs leading-5 text-muted">按占用从大到小排列。</p>
          <ul className="m-0 flex list-none flex-col divide-y divide-white/6 p-0">
            {shown.map((s) => (
              <SongRow key={s.songId} song={s} onClearPitched={() => remove(s, ['pitched'])} onRemove={() => setConfirm(s)} />
            ))}
          </ul>
          {songs.length > PREVIEW_COUNT && (
            <button
              type="button"
              onClick={() => setAll((v) => !v)}
              className="self-start text-sm text-accent-soft hover:underline"
            >
              {all ? '收起' : `显示全部 ${songs.length} 首`}
            </button>
          )}
        </>
      )}
      <ConfirmDialog
        open={!!confirm}
        title="从缓存移除这首歌？"
        message={`《${confirm?.name ?? confirm?.songId ?? ''}》的原曲、伴奏、变调音频和 MV 都会删除，释放 ${fmtBytes(confirm?.bytes ?? 0)}。再点这首歌时会重新下载和分离。`}
        confirmLabel="移除"
        onConfirm={() => confirm && remove(confirm)}
        onClose={() => setConfirm(null)}
      />
    </Card>
  )
}

function SongRow({ song, onClearPitched, onRemove }: { song: CachedSongInfo; onClearPitched: () => void; onRemove: () => void }) {
  const pitchedPending = useIsPending(clearKey(`song:${song.songId}:pitched`))
  const allPending = useIsPending(clearKey(`song:${song.songId}:all`))
  const kinds = MEDIA_ORDER.filter((k) => song.kinds[k])
  return (
    <li className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
      <Cover url={song.cover} seed={song.songId} px={80} size={40} className="rounded-lg" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-semibold">{song.name ?? `歌曲 ${song.songId}`}</span>
          {song.keep && (
            <span className="shrink-0 rounded-md bg-white/8 px-1.5 py-0.5 text-[11px] text-fg-2">{KEEP[song.keep]}</span>
          )}
        </span>
        <span className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-0.5 text-xs text-muted">
          {song.artists && <span className="max-w-[12em] truncate">{song.artists}</span>}
          {kinds.map((k) => (
            <span key={k} className="num flex items-center gap-1 whitespace-nowrap">
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: MEDIA[k].color }} />
              {SHORT[k]}
              {k === 'pitched' && song.keys.length > 0 && ` ${song.keys.length} 个调`} {fmtBytes(song.kinds[k]!)}
            </span>
          ))}
        </span>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1.5 sm:flex-row sm:items-center sm:gap-3">
        <span className="num hidden text-right text-xs text-muted sm:block">
          <span className="block text-sm text-fg-2">{fmtBytes(song.bytes)}</span>
          {fmtAgo(song.lastUsed)}
        </span>
        {!song.keep && (
          <div className="flex gap-1.5">
            {song.kinds.pitched ? (
              <button
                type="button"
                onClick={onClearPitched}
                disabled={pitchedPending}
                title="只删除这首歌的变调音频"
                className="flex h-8 items-center gap-1 rounded-lg bg-white/6 px-2.5 text-xs whitespace-nowrap text-fg-2 hover:bg-white/10 disabled:opacity-50"
              >
                {pitchedPending && <Spinner size={12} />}
                清变调
              </button>
            ) : null}
            <button
              type="button"
              onClick={onRemove}
              disabled={allPending}
              aria-label={`从缓存移除 ${song.name ?? song.songId}`}
              className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/6 text-fg-2 hover:bg-white/10 hover:text-accent-soft disabled:opacity-50"
            >
              {allPending ? <Spinner size={13} /> : <Icon name="trash" size={14} />}
            </button>
          </div>
        )}
      </div>
    </li>
  )
}

// ---------------- 网易云数据缓存 ----------------

const DATA_ORDER: DataCacheKind[] = ['search', 'library', 'recommend', 'lyrics', 'songs']

function DataCard() {
  const cache = useCacheInfo()
  const clear = useClear()
  const allPending = useIsPending(clearKey('data'))
  const total = cache.data?.data.reduce((a, g) => a + g.count, 0) ?? 0
  return (
    <Card
      title="网易云数据缓存"
      action={
        <ClearButton
          label="全部清除"
          pending={allPending}
          disabled={!total}
          onClick={() => void clear('data', api.clearDataCache, () => '数据缓存已清除，列表会重新从网易云获取', true)}
        />
      }
    >
      <p className="m-0 -mt-2 text-xs leading-5 text-muted">
        列表和歌词先读缓存，加载更快；过期后先显示旧内容并在后台更新，网易云出错时也先用缓存顶上。清除后重新从网易云获取。
      </p>
      <ul className="m-0 flex list-none flex-col divide-y divide-white/6 p-0">
        {DATA_ORDER.map((kind) => (
          <KindRow
            key={kind}
            kind={kind}
            group={cache.data?.data.find((g) => g.kind === kind)}
            label={DATA[kind].label}
            note={DATA[kind].note}
            unit="条"
            onClear={() => void clear(kind, () => api.clearCacheKind(kind), () => `已清除${DATA[kind].label}`, true)}
          />
        ))}
      </ul>
    </Card>
  )
}
