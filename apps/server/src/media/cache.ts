import fs from 'node:fs'
import path from 'node:path'
import { apiCacheStats } from '../apiCache.js'
import { paths } from '../config.js'
import { hub } from '../core/hub.js'
import { priorityIds } from '../core/player.js'
import { getCachedSong } from '../ncm/service.js'
import { getSettings } from '../settings.js'
import type { CacheInfo } from '../shared/types.js'

/**
 * Disk cache for song audio / stems (data/media/<songId>/) and MVs (data/mv/<mvId>_<res>.mp4).
 * When the total exceeds settings.cacheLimitGB, the least recently used entries are removed —
 * never the current song or anything in the queue.
 */

const GB = 1024 ** 3
const ACCESS_MARK = '.access'

function dirSize(dir: string): number {
  let total = 0
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name)
    if (ent.isDirectory()) total += dirSize(p)
    else {
      try {
        total += fs.statSync(p).size
      } catch {
        /* removed meanwhile */
      }
    }
  }
  return total
}

function mtime(p: string): number {
  try {
    return fs.statSync(p).mtimeMs
  } catch {
    return 0
  }
}

/** Remember that a song's files were just used (LRU). */
export function touchSong(songId: number): void {
  const dir = paths.media(songId)
  if (!fs.existsSync(dir)) return
  const mark = path.join(dir, ACCESS_MARK)
  const now = new Date()
  try {
    if (fs.existsSync(mark)) fs.utimesSync(mark, now, now)
    else fs.writeFileSync(mark, '')
  } catch {
    /* best effort */
  }
}

export function touchFile(file: string): void {
  const now = new Date()
  try {
    fs.utimesSync(file, now, now)
  } catch {
    /* best effort */
  }
}

interface Entry {
  kind: 'song' | 'mv'
  id: number
  path: string
  bytes: number
  lastUsed: number
}

function scan(): Entry[] {
  const entries: Entry[] = []
  const mediaRoot = paths.mediaRoot()
  if (fs.existsSync(mediaRoot)) {
    for (const name of fs.readdirSync(mediaRoot)) {
      const id = Number(name)
      const dir = path.join(mediaRoot, name)
      if (!Number.isInteger(id) || !fs.statSync(dir).isDirectory()) continue
      entries.push({
        kind: 'song',
        id,
        path: dir,
        bytes: dirSize(dir),
        lastUsed: Math.max(mtime(path.join(dir, ACCESS_MARK)), mtime(dir)),
      })
    }
  }
  const mvRoot = paths.mvRoot()
  if (fs.existsSync(mvRoot)) {
    for (const name of fs.readdirSync(mvRoot)) {
      const m = /^(\d+)_\d+\.mp4$/.exec(name)
      if (!m) continue
      const file = path.join(mvRoot, name)
      entries.push({ kind: 'mv', id: Number(m[1]), path: file, bytes: fs.statSync(file).size, lastUsed: mtime(file) })
    }
  }
  return entries
}

function protectedSets(): { songs: Set<number>; mvs: Set<number> } {
  const songs = new Set(priorityIds())
  const mvs = new Set<number>()
  for (const id of songs) {
    const mv = getCachedSong(id)?.mvId
    if (mv) mvs.add(mv)
  }
  return { songs, mvs }
}

function remove(e: Entry): void {
  fs.rmSync(e.path, { recursive: true, force: true })
  if (e.kind === 'song') {
    // The song has to be downloaded and separated again next time it is requested.
    hub.setTrack(e.id, { status: 'idle', progress: 0, hasStems: false, hasPitch: false, message: undefined, source: undefined })
  }
}

export function cacheInfo(): CacheInfo {
  const entries = scan()
  const audioBytes = entries.filter((e) => e.kind === 'song').reduce((a, e) => a + e.bytes, 0)
  const mvBytes = entries.filter((e) => e.kind === 'mv').reduce((a, e) => a + e.bytes, 0)
  const data = apiCacheStats()
  return {
    usedBytes: audioBytes + mvBytes,
    limitBytes: getSettings().cacheLimitGB * GB,
    audioBytes,
    mvBytes,
    songs: entries.filter((e) => e.kind === 'song').length,
    mvs: entries.filter((e) => e.kind === 'mv').length,
    dataEntries: data.entries,
    dataBytes: data.bytes,
  }
}

let enforcing = false

/** Evict least-recently-used songs / MVs until the cache fits the limit. */
export function enforceCacheLimit(): void {
  if (enforcing) return
  enforcing = true
  try {
    const limit = getSettings().cacheLimitGB * GB
    const entries = scan()
    let used = entries.reduce((a, e) => a + e.bytes, 0)
    if (used <= limit) return
    const keep = protectedSets()
    const candidates = entries
      .filter((e) => (e.kind === 'song' ? !keep.songs.has(e.id) : !keep.mvs.has(e.id)))
      .sort((a, b) => a.lastUsed - b.lastUsed)
    for (const e of candidates) {
      if (used <= limit) break
      remove(e)
      used -= e.bytes
      console.log(`[cache] evicted ${e.kind} ${e.id} (${(e.bytes / 1024 ** 2).toFixed(0)} MB)`)
    }
  } catch (err) {
    console.warn('[cache] enforce failed:', (err as Error).message)
  } finally {
    enforcing = false
  }
}

/** Remove everything except the current / queued songs and their MVs. */
export function clearCache(): CacheInfo {
  const keep = protectedSets()
  for (const e of scan()) {
    if (e.kind === 'song' ? keep.songs.has(e.id) : keep.mvs.has(e.id)) continue
    remove(e)
  }
  fs.rmSync(paths.tmp(), { recursive: true, force: true })
  return cacheInfo()
}
