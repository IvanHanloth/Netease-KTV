import { useMemo, useState, type ReactNode } from 'react'
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import type { PlaylistSummary } from '@shared/types'
import { api, withFreshData } from '../../lib/api'
import { errorText, toast, useAccount, useHistory } from '../../lib/hooks'
import { Icon } from '../../components/icons'
import { Cover, EmptyNote, QueryError, Spinner } from '../../components/ui'
import { RecCard, SongTable } from '../../components/SongTable'
import { DEVICE_ONLY_NOTE } from '../../components/ImportPlaylist'
import { useImportedPlaylists } from '../../lib/importedPlaylists'
import { type View } from './nav'

/** 点歌台 content views: recommendations, search results, toplists, playlists, albums, artists, history. */

export function Section({ title, action, children, as: H = 'h2' }: { title: string; action?: ReactNode; children: ReactNode; as?: 'h1' | 'h2' }) {
  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <H className="m-0 text-xl font-bold">{title}</H>
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
export function PageActions({ back, children }: { back?: () => void; children?: ReactNode }) {
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

export function Loading() {
  return (
    <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted">
      <Spinner /> 加载中…
    </div>
  )
}

export function ErrorNote({ error, retry, retrying }: { error: unknown; retry: () => void; retrying?: boolean }) {
  return <QueryError error={new Error(errorText(error))} onRetry={retry} retrying={retrying} />
}

export const quickTags = ['华语', '粤语', '欧美', '日语', '经典老歌', '合唱', '民谣', '摇滚']

export function RecommendView({ go }: { go: (v: View) => void }) {
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

export function InfiniteSongs({ queryKey, fetchPage }: { queryKey: unknown[]; fetchPage: (offset: number) => ReturnType<typeof api.search> }) {
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

export function SearchView({ q }: { q: string }) {
  return (
    <Section as="h1" title={`“${q}” 的搜索结果`} action={<PageActions />}>
      <InfiniteSongs queryKey={['search', q]} fetchPage={(offset) => api.search(q, offset, 30)} />
    </Section>
  )
}

export function PlaylistCard({ p, onOpen }: { p: PlaylistSummary; onOpen: () => void }) {
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

export function ToplistsView({ go }: { go: (v: View) => void }) {
  const q = useQuery({ queryKey: ['toplists'], queryFn: api.toplists, staleTime: 10 * 60_000 })
  return (
    <Section as="h1" title="热歌榜" action={<PageActions />}>
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

export function PlaylistView({ id, name, back }: { id: number; name: string; back: () => void }) {
  const imported = useImportedPlaylists().some((p) => p.id === id)
  return (
    <Section as="h1" title={name} action={<PageActions back={back} />}>
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

export function DetailHeader({
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

export function AlbumView({ id, name, go, back }: { id: number; name: string; go: (v: View) => void; back: () => void }) {
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

export function ArtistView({ id, name, back }: { id: number; name: string; back: () => void }) {
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

export function HistoryView() {
  const q = useHistory()
  const songs = q.data?.songs ?? []
  return (
    <Section
      as="h1"
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
