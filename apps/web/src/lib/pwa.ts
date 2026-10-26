/**
 * PWA wiring: each page can be installed as its own app (点歌台, 大屏, 手机点歌, 移动耳返, 后台),
 * so the manifest link follows the current page; and the service worker that caches the app shell.
 */

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
  if (!import.meta.env.PROD || !('serviceWorker' in navigator) || !window.isSecureContext) return
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {})
  })
}
