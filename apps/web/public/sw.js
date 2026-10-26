/*
 * Netease KTV service worker: makes the pages installable and the app shell load instantly.
 * Only the shell is cached (HTML, hashed JS/CSS/fonts, icons). Nothing under /api — songs, lists,
 * audio and the WebSocket — ever goes through a cache here: the app is live by nature.
 */

/** Replaced with the build id at build time: each release gets a fresh shell cache. */
const BUILD = '__BUILD_ID__'
const SHELL = `ktv-shell-${BUILD}`
/** Hashed files keep their names across releases, so this cache is shared by all of them. */
const ASSETS = 'ktv-assets-v1'
/** Hashed build files kept; older ones are dropped first. */
const MAX_ASSETS = 160
/** A navigation waits this long for the server before the cached shell is shown. */
const NAV_TIMEOUT_MS = 3000

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((c) => c.addAll(['/', '/favicon.svg', '/icons/icon-192.png'].map((u) => new Request(u, { cache: 'reload' }))))
      .catch(() => {}),
  )
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key !== SHELL && key !== ASSETS) await caches.delete(key)
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET' || req.headers.has('range')) return
  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return
  if (url.pathname.startsWith('/api/') || url.pathname === '/sw.js' || url.pathname === '/version.json') return
  if (req.mode === 'navigate') event.respondWith(navigate(req))
  else if (url.pathname.startsWith('/assets/')) event.respondWith(cacheFirst(req))
  else event.respondWith(staleWhileRevalidate(req))
})

/** Every page is the same index.html: fresh from the server, the cached copy when it is slow or away. */
async function navigate(req) {
  const cache = await caches.open(SHELL)
  const fresh = fetch(req).then((res) => {
    if (res.ok) void cache.put('/', res.clone())
    return res
  })
  const timeout = new Promise((resolve) => setTimeout(resolve, NAV_TIMEOUT_MS))
  try {
    const res = await Promise.race([fresh, timeout])
    if (res) return res
  } catch {
    /* offline: fall through to the cache */
  }
  const cached = await cache.match('/')
  if (cached) return cached
  try {
    return await fresh
  } catch {
    return new Response(
      '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
        '<body style="margin:0;display:grid;place-items:center;height:100vh;background:#0a0a0f;color:#d4d4dc;font-family:sans-serif">' +
        '<p>连不上 KTV 服务器，请确认和它在同一个 Wi‑Fi 下</p></body>',
      { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
    )
  }
}

/** Hashed build files never change under the same name. */
async function cacheFirst(req) {
  const cache = await caches.open(ASSETS)
  const hit = await cache.match(req)
  if (hit) return hit
  const res = await fetch(req)
  if (res.ok && res.type === 'basic') {
    await cache.put(req, res.clone())
    void trim(cache)
  }
  return res
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(SHELL)
  const hit = await cache.match(req)
  const fresh = fetch(req)
    .then((res) => {
      if (res.ok && res.type === 'basic') void cache.put(req, res.clone())
      return res
    })
    .catch(() => hit || Response.error())
  return hit || fresh
}

async function trim(cache) {
  const keys = await cache.keys()
  for (let i = 0; i < keys.length - MAX_ASSETS; i++) await cache.delete(keys[i])
}
