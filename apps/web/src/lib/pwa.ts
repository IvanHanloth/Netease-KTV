/**
 * PWA wiring: each page can be installed as its own app (点歌台, 大屏, 手机点歌, 移动耳返, 后台),
 * so the manifest link follows the current page; and the service worker that caches the app shell.
 */

import { toast } from './hooks'

const APPS: { path: string; manifest: string; title: string }[] = [
  { path: '/tv', manifest: 'tv', title: 'KTV 大屏' },
  { path: '/m', manifest: 'remote', title: 'KTV 点歌' },
  { path: '/ear', manifest: 'ear', title: 'KTV 耳返' },
  { path: '/admin', manifest: 'admin', title: 'KTV 后台' },
]

/** Point the manifest (and the iOS home-screen title) at the app for `pathname`. */
export function syncManifest(pathname: string): void {
  const app = APPS.find((a) => pathname === a.path || pathname.startsWith(a.path + '/'))
  const href = `/manifests/${app?.manifest ?? 'desk'}.webmanifest`
  const link = document.querySelector<HTMLLinkElement>('link[rel="manifest"]')
  if (link && link.getAttribute('href') !== href) link.setAttribute('href', href)
  // Lets CSS tell the apps apart (the 大屏 keeps its full-bleed layout under the window buttons).
  document.documentElement.dataset.app = app?.manifest ?? 'desk'
  document.querySelector('meta[name="apple-mobile-web-app-title"]')?.setAttribute('content', app?.title ?? 'KTV 点歌台')
}

/**
 * Service workers only run in a secure context: https, or the server's own machine (localhost).
 * Over plain http on the LAN the pages still work and can be added to the home screen; they just
 * load without the cached shell.
 */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD) return
  if ('serviceWorker' in navigator && window.isSecureContext) {
    window.addEventListener('load', () => {
      navigator.serviceWorker
        .register('/sw.js')
        .then((r) => (registration = r))
        .catch(() => {})
    })
  }
  // Releases come with a server restart, so a reconnect (main.tsx) is the main check; these catch
  // a page that was asleep in the background or left open for days.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void checkForUpdate()
  })
  setInterval(() => void checkForUpdate(), UPDATE_CHECK_MS)
}

/* ---------------------------------------------------------------------------------------------
 * Auto-update: every build has its own id (vite.config.ts). When the server's /version.json names
 * a different one, the page reloads itself onto the new release.
 * ------------------------------------------------------------------------------------------- */

const UPDATE_CHECK_MS = 30 * 60_000
/** Remembers which release a reload was for, so a page that still loads the old one doesn't loop. */
const TRIED_KEY = 'ktv-update-tried'

let registration: ServiceWorkerRegistration | undefined
let pendingBuild: string | undefined
let holds = 0

/** Ask the server which release it runs; reload onto it when it isn't this one. */
export async function checkForUpdate(): Promise<void> {
  if (!import.meta.env.PROD || pendingBuild) return
  let build: unknown
  try {
    const res = await fetch('/version.json', { cache: 'no-store' })
    if (!res.ok) return
    build = ((await res.json()) as { build?: unknown }).build
  } catch {
    return
  }
  if (typeof build !== 'string' || build === __BUILD_ID__) return
  if (readTried() === build) return // already reloaded once for it and still got the old page
  pendingBuild = build
  // Fetch the new service worker now, so the reload is served by it.
  await registration?.update().catch(() => {})
  applyUpdate()
}

/**
 * While held (e.g. 后台 has unsaved settings), a new release waits instead of reloading the page.
 * Returns the release function.
 */
export function holdUpdates(): () => void {
  holds++
  let released = false
  return () => {
    if (released) return
    released = true
    holds--
    if (holds === 0 && pendingBuild) applyUpdate()
  }
}

function applyUpdate(): void {
  if (holds > 0) {
    toast('有新版本可用，保存后会自动更新', 'ok')
    return
  }
  const reload = () => {
    writeTried(pendingBuild!)
    location.reload()
  }
  if (document.visibilityState === 'hidden') return reload()
  toast('已有新版本，正在更新…')
  setTimeout(reload, 1500)
}

function readTried(): string | null {
  try {
    return sessionStorage.getItem(TRIED_KEY)
  } catch {
    return null
  }
}

function writeTried(build: string): void {
  try {
    sessionStorage.setItem(TRIED_KEY, build)
  } catch {
    /* private mode: the check above just won't guard against a second reload */
  }
}
