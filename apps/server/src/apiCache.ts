import { getDb } from './db.js'

/**
 * Cache for NetEase data (toplists, playlists, daily recommend, search, lyrics…), stored in
 * SQLite so it survives restarts. Each kind has its own TTL. When NetEase fails, an expired
 * entry is served instead of an error (stale-if-error). Cleared from the settings page.
 */

export const MIN = 60_000
export const HOUR = 60 * MIN
export const DAY = 24 * HOUR

const inflight = new Map<string, Promise<unknown>>()

function read(key: string): { value: unknown; fresh: boolean } | null {
  const row = getDb().prepare('SELECT value, expires_at FROM api_cache WHERE key = ?').get(key) as
    | { value: string; expires_at: number }
    | undefined
  if (!row) return null
  try {
    return { value: JSON.parse(row.value), fresh: row.expires_at > Date.now() }
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

/** Return the cached value for `key`, or compute, store and return it. */
export async function cached<T>(key: string, ttl: number, load: () => Promise<T>): Promise<T> {
  const hit = read(key)
  if (hit?.fresh) return hit.value as T
  const running = inflight.get(key)
  if (running) return running as Promise<T>
  const job = (async () => {
    try {
      const value = await load()
      write(key, value, ttl)
      return value
    } catch (err) {
      if (hit) {
        console.warn(`[cache] ${key}: NetEase failed, serving stale data (${(err as Error).message})`)
        return hit.value as T
      }
      throw err
    }
  })().finally(() => inflight.delete(key))
  inflight.set(key, job)
  return job
}

export function apiCacheStats(): { entries: number; bytes: number } {
  const row = getDb().prepare('SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(value)), 0) AS bytes FROM api_cache').get() as {
    n: number
    bytes: number
  }
  return { entries: row.n, bytes: row.bytes }
}

/**
 * Drop all cached NetEase data. Song details are only marked stale (not deleted): the queue is
 * restored from them on startup, so they are refreshed on next use instead.
 */
export function clearApiCache(): number {
  const db = getDb()
  const a = db.prepare('DELETE FROM api_cache').run()
  db.prepare('UPDATE songs SET updated_at = 0').run()
  return Number(a.changes)
}

/** Drop expired entries now and then so the table doesn't grow forever. */
export function pruneApiCache(): void {
  getDb().prepare('DELETE FROM api_cache WHERE expires_at < ?').run(Date.now() - 7 * DAY)
}
