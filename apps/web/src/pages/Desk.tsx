import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigationType } from 'react-router'
import clsx from 'clsx'
import { DeskNavContext, type DeskNav } from '../lib/deskNav'
import { stopPreview } from '../lib/preview'
import { connect } from '../store/app'
import { QueuePanel } from '../components/QueuePanel'
import { Leaderboard } from '../components/Leaderboard'
import { LoginDialog } from '../components/LoginDialog'
import { SettingsDialog } from '../components/SettingsDialog'
import { ImportPlaylistDialog } from '../components/ImportPlaylist'
import { MobileTopBar, QueueChip, QueueDrawer, Sidebar, useMediaQuery, useView } from './desk/nav'
import { SearchBox, SeparatorChip } from './desk/search'
import { AlbumView, ArtistView, HistoryView, PageActions, PlaylistView, RecommendView, SearchView, Section, ToplistsView } from './desk/views'

export default function Desk() {
  const [view, go] = useView()
  const [loginOpen, setLoginOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const wide = useMediaQuery('(min-width: 1280px)')
  const lg = useMediaQuery('(min-width: 1024px)')
  const [queueOpen, setQueueOpen] = useState(false)
  useEffect(() => {
    if (wide) setQueueOpen(false)
  }, [wide])

  // Each history entry keeps its own scroll position: a new view starts at the top, going back
  // returns to where the list was. On wide screens <main> scrolls, on phones the window does.
  const mainRef = useRef<HTMLElement>(null)
  const location = useLocation()
  const navType = useNavigationType()
  const scrollPos = useRef(new Map<string, number>())
  const scroller = (): { top: number; to: (y: number) => void } =>
    lg && mainRef.current
      ? { top: mainRef.current.scrollTop, to: (y) => mainRef.current?.scrollTo({ top: y }) }
      : { top: window.scrollY, to: (y) => window.scrollTo({ top: y }) }
  const [scrolled, setScrolled] = useState(false)
  // The entry scroll events belong to: switched before the new view scrolls, so the reset of the
  // old view's scroll position is never recorded as where the old entry was.
  const entryKey = useRef(location.key)
  useEffect(() => {
    const target: HTMLElement | Window | null = lg ? mainRef.current : window
    if (!target) return
    const onScroll = () => {
      const top = scroller().top
      scrollPos.current.set(entryKey.current, top)
      setScrolled(top > 4)
    }
    onScroll()
    target.addEventListener('scroll', onScroll, { passive: true })
    return () => target.removeEventListener('scroll', onScroll)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lg])
  useLayoutEffect(() => {
    if (entryKey.current === location.key) return
    entryKey.current = location.key
    scroller().to(navType === 'POP' ? (scrollPos.current.get(location.key) ?? 0) : 0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.key])

  useEffect(() => connect('desk'), [])
  useEffect(() => {
    document.title = '点歌台 · Netease KTV'
  }, [])
  const goRef = useRef(go)
  goRef.current = go
  const nav = useMemo<DeskNav>(
    () => ({
      openAlbum: (id, name) => goRef.current({ kind: 'album', id, name }),
      openArtist: (id, name) => goRef.current({ kind: 'artist', id, name }),
    }),
    [],
  )
  // 试听 stops when leaving the page or switching views.
  useEffect(() => stopPreview, [])
  const viewKey = JSON.stringify(view)
  useEffect(() => stopPreview(), [viewKey])

  const content = (
    <>
      {/* Search stays pinned to the top while the page scrolls. */}
      <div
        className={clsx(
          'pointer-events-none sticky top-0 z-30 -mx-4 -mt-6 flex items-center gap-3 px-4 pt-6 pb-3 transition-[background-color] duration-200 sm:-mx-8 sm:gap-4 sm:px-8 lg:-mx-10 lg:-mt-7 lg:px-10 lg:pt-7 [&>*]:pointer-events-auto',
          // Once lists scroll underneath, a backdrop keeps them from showing through.
          scrolled && 'bg-ink/80 backdrop-blur-md',
        )}
      >
        <SearchBox initial={view.kind === 'search' ? view.q : ''} onSearch={(q) => go({ kind: 'search', q })} />
        <SeparatorChip />
        {lg && !wide && <QueueChip onOpen={() => setQueueOpen(true)} />}
      </div>
      {view.kind === 'recommend' && <RecommendView go={go} />}
      {view.kind === 'search' && <SearchView q={view.q} />}
      {view.kind === 'toplists' && <ToplistsView go={go} />}
      {view.kind === 'scores' && (
        <Section as="h1" title="K 歌排行" action={<PageActions />}>
          <Leaderboard manage />
        </Section>
      )}
      {view.kind === 'history' && <HistoryView />}
      {view.kind === 'album' && <AlbumView key={view.id} id={view.id} name={view.name} go={go} back={() => window.history.back()} />}
      {view.kind === 'artist' && <ArtistView key={view.id} id={view.id} name={view.name} back={() => window.history.back()} />}
      {view.kind === 'playlist' && <PlaylistView id={view.id} name={view.name} back={() => window.history.back()} />}
    </>
  )

  return (
    <DeskNavContext.Provider value={nav}>
    <div className="relative min-h-full overflow-clip bg-ink text-fg lg:h-full">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-[380px] left-[160px] h-[760px] w-[760px] rounded-full opacity-[0.16] blur-[20px]"
        style={{ background: 'radial-gradient(circle, #FF4D7E 0%, rgba(0,0,0,0) 62%)' }}
      />
      <div className="relative grid min-h-full grid-cols-1 lg:h-full lg:grid-cols-[232px_minmax(0,1fr)] xl:grid-cols-[232px_minmax(0,1fr)_352px]">
        {lg ? (
          <aside className="min-h-0 border-r border-white/6">
            <Sidebar
              view={view}
              go={go}
              onLogin={() => setLoginOpen(true)}
              onSettings={() => setSettingsOpen(true)}
              onImport={() => setImportOpen(true)}
            />
          </aside>
        ) : (
          <MobileTopBar
            view={view}
            go={go}
            onLogin={() => setLoginOpen(true)}
            onSettings={() => setSettingsOpen(true)}
            onImport={() => setImportOpen(true)}
          />
        )}
        <main ref={mainRef} className="flex min-w-0 flex-col gap-8 px-4 pt-6 pb-10 sm:px-8 lg:overflow-y-auto lg:px-10 lg:pt-7">
          {content}
          {!lg && (
            <section className="rounded-3xl border border-white/6 bg-white/[0.015] p-5">
              <QueuePanel />
            </section>
          )}
        </main>
        {wide && (
          <aside aria-label="已点歌曲" className="min-h-0 border-l border-white/6 bg-white/[0.015] px-6 py-7">
            <QueuePanel />
          </aside>
        )}
      </div>
      {lg && !wide && <QueueDrawer open={queueOpen} onClose={() => setQueueOpen(false)} />}
      <LoginDialog open={loginOpen} onClose={() => setLoginOpen(false)} />
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <ImportPlaylistDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={(p) => go({ kind: 'playlist', id: p.id, name: p.name })}
      />
    </div>
    </DeskNavContext.Provider>
  )
}
