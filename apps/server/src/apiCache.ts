import { AsyncLocalStorage } from 'node:async_hooks'
import { getDb } from './db.js'
import type { CacheGroup, DataCacheKind } from './shared/types.js'

/**
 * Cache for NetEase data (toplists, playlists, daily recommend, search, lyrics…), stored in
 * SQLite so it survives restarts. Each kind has its own TTL. An expired entry is still served
 * for a while and refreshed in the background (stale-while-revalidate); when NetEase fails, the
 * old entry is served instead of an error (stale-if-error). Cleared per kind from /admin.
 */

export const MIN = 60_000
export const HOUR = 60 * MIN
export const DAY = 24 * HOUR

/** After its TTL, an entry is still served (while a fresh copy loads) for this long. */
const SERVE_STALE_MS = 3 * DAY

/** Key prefixes of each data kind. Every cached() key must start with one of them. */
const PREFIXES: Record<Exclude<DataCacheKind, 'songs'>, string[]> = {
  search: ['search:', 'suggest:'],
  library: ['playlist:', 'playlistDetail:', 'album:', 'artist:', 'artistSongs:', 'userPlaylists:'],
  recommend: ['daily:', 'toplists'],
  lyrics: ['lyrics:'],
}

export function dataKindOfKey(key: string): Exclude<DataCacheKind, 'songs'> | null {
  for (const [kind, prefixes] of Object.entries(PREFIXES)) {
    if (prefixes.some((p) => key.startsWith(p))) return kind as Exclude<DataCacheKind, 'songs'>
  }
  return null
}

const inflight = new Map<string, Promise<unknown>>()
const warned = new Set<string>()

/** Set for requests with `?fresh=1` (the desk's refresh button): skip cache hits, refetch. */
export const bypassCache = new AsyncLocalStorage<boolean>()

interface Hit {
  value: unknown
  expiresAt: number
}

function read(key: string): Hit | null {
  const row = getDb().prepare('SELECT value, expires_at FROM api_cache WHERE key = ?').get(key) as
    | { value: string; expires_at: number }
    | undefined
  if (!row) return null
  try {
    return { value: JSON.parse(row.value), expiresAt: row.expires_at }
  } catch {
    return null
  }
}

function write(key: string, value: unknown, ttl: number): void {
  getDb()
    .prepare(
      'INSERT INTO api_cache (key, value, expires_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at',
    )
    .run(key, JSON.stringify(value), Date.now() + ttl)
}

/** Load and store `key` (one request at a time per key); on failure fall back to `stale`. */
function load<T>(key: string, ttl: number, fetcher: () => Promise<T>, stale: Hit | null): Promise<T> {
  const running = inflight.get(key)
  if (running) return running as Promise<T>
  const job = (async () => {
    try {
      const value = await fetcher()
      write(key, value, ttl)
      return value
    } catch (err) {
      if (stale) {
        console.warn(`[cache] ${key}: NetEase failed, serving stale data (${(err as Error).message})`)
        return stale.value as T
      }
      throw err
    }
  })().finally(() => inflight.delete(key))
  inflight.set(key, job)
  return job
}

/** Return the cached value for `key`, or compute, store and return it. */
export async function cached<T>(key: string, ttl: number, fetcher: () => Promise<T>): Promise<T> {
  if (!dataKindOfKey(key) && !warned.has(key.split(':')[0]!)) {
    warned.add(key.split(':')[0]!)
    console.warn(`[cache] key "${key}" has no data kind: add its prefix to PREFIXES in apiCache.ts`)
  }
  const hit = read(key)
  if (hit && !bypassCache.getStore()) {
    const now = Date.now()
    if (hit.expiresAt > now) return hit.value as T
    if (now - hit.expiresAt < SERVE_STALE_MS) {
      // Stale: answer now, refresh behind the scenes for the next request.
      void load(key, ttl, fetcher, hit).catch(() => {})
      return hit.value as T
    }
  }
  return load(key, ttl, fetcher, hit)
}

/** Entries and bytes per data kind (song details included). */
export function dataCacheGroups(): CacheGroup[] {
  const db = getDb()
  const totals = new Map<DataCacheKind, { count: number; bytes: number }>()
  const add = (kind: DataCacheKind, bytes: number) => {
    const t = totals.get(kind) ?? { count: 0, bytes: 0 }
    t.count++
    t.bytes += bytes
    totals.set(kind, t)
  }
  const rows = db.prepare('SELECT key, LENGTH(CAST(value AS BLOB)) AS bytes FROM api_cache').all() as {
    key: string
    bytes: number
  }[]
  for (const r of rows) add(dataKindOfKey(r.key) ?? 'library', r.bytes)
  const songs = db
    .prepare('SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(CAST(data AS BLOB))), 0) AS bytes FROM songs')
    .get() as { n: number; bytes: number }
  totals.set('songs', { count: songs.n, bytes: songs.bytes })
  const order: DataCacheKind[] = ['search', 'library', 'recommend', 'lyrics', 'songs']
  return order.map((kind) => ({ kind, count: totals.get(kind)?.count ?? 0, bytes: totals.get(kind)?.bytes ?? 0, protectedBytes: 0 }))
}

/**
 * Drop one kind of cached NetEase data; returns the rows affected. Song details are only marked
 * stale (not deleted): the queue is restored from them on startup, so they refresh on next use.
 */
export function clearDataKind(kind: DataCacheKind): number {
  const db = getDb()
  if (kind === 'songs') return Number(db.prepare('UPDATE songs SET updated_at = 0').run().changes)
  let removed = 0
  const del = db.prepare('DELETE FROM api_cache WHERE substr(key, 1, ?) = ?')
  for (const prefix of PREFIXES[kind]) removed += Number(del.run(prefix.length, prefix).changes)
  return removed
}

/** Drop all cached NetEase data (unknown keys included). */
export function clearApiCache(): number {
  const db = getDb()
  const a = db.prepare('DELETE FROM api_cache').run()
  db.prepare('UPDATE songs SET updated_at = 0').run()
  return Number(a.changes)
}

/** Drop entries too old to be served even as stale data, so the table doesn't grow forever. */
export function pruneApiCache(): void {
  getDb().prepare('DELETE FROM api_cache WHERE expires_at < ?').run(Date.now() - 7 * DAY)
}
