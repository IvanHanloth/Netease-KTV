import path from 'node:path'
import { clearApiCache, clearDataKind, dataCacheGroups } from '../apiCache.js'
import { busyMvIds, busySongIds } from '../media/busy.js'
import { type CacheFile, type CacheScan, removeFiles, removeSongDir, scanCache } from '../media/cache.js'
import { findOriginal, hasPitch, hasStems, stemOfPitched } from '../media/files.js'
import { clearLinks, getCachedSong } from '../ncm/service.js'
import { getSettings } from '../settings.js'
import { MEDIA_CACHE_KINDS } from '../shared/constants.js'
import type { CacheGroup, CacheInfo, CachedSongInfo, DataCacheKind, MediaCacheKind } from '../shared/types.js'
import { hub } from './hub.js'
import { getPlayer, priorityIds } from './player.js'

/**
 * Cache policy: what is kept, what goes first, and keeping track state in step with the disk.
 *
 * Kept (never cleared or evicted): the current and queued songs and their MVs, 待机音乐 songs,
 * and anything being written right now (media/busy.ts).
 *
 * Over the limit, the cheapest things to rebuild go first:
 *   1. leftovers of unfinished writes
 *   2. key-shift renders (ffmpeg, seconds)
 *   3. whole songs and MVs, least recently used first
 */

const GB = 1024 ** 3
/** Unfinished writes this old are leftovers (a live download touches its file constantly). */
const LEFTOVER_MS = 10 * 60_000

type Keep = NonNullable<CachedSongInfo['keep']>

export class CacheError extends Error {
  constructor(
    message: string,
    public status = 409,
  ) {
    super(message)
  }
}

function keepers(): { songs: Map<number, Keep>; mvs: Set<number> } {
  const songs = new Map<number, Keep>()
  const current = getPlayer().current?.song.id
  for (const id of priorityIds()) songs.set(id, id === current ? 'playing' : 'queued')
  for (const id of getSettings().idleSongs) if (!songs.has(id)) songs.set(id, 'idle-music')
  for (const id of busySongIds()) if (!songs.has(id)) songs.set(id, 'busy')
  const mvs = new Set(busyMvIds())
  for (const [id, why] of songs) {
    if (why === 'idle-music') continue
    const mv = getCachedSong(id)?.mvId
    if (mv) mvs.add(mv)
  }
  return { songs, mvs }
}

const isLeftover = (f: CacheFile, now = Date.now()) => now - f.mtime > LEFTOVER_MS

function totalBytes(scan: CacheScan): number {
  let n = 0
  for (const s of scan.songs) n += s.bytes
  for (const m of scan.mvs) n += m.file.bytes
  for (const f of scan.loose) n += f.bytes
  return n
}

/** Renders made from `kind` (removed along with it: they are useless without their source). */
function derivedFrom(kind: MediaCacheKind, f: CacheFile): boolean {
  if (f.kind !== 'pitched') return false
  const stem = stemOfPitched(path.basename(f.rel))
  if (kind === 'original') return stem === 'original'
  if (kind === 'stems') return stem === 'instrumental' || stem === 'vocals'
  return false
}

// ---------- track state ----------

/**
 * Bring a song's track state in line with what is on disk after files were removed: no stems
 * any more → back to idle (the pipeline downloads / separates again when the song is queued).
 * Idle tracks with nothing on disk are forgotten so the state snapshot doesn't grow forever.
 */
export function syncTrackFromDisk(songId: number): void {
  if (!hub.tracks.has(songId)) return
  const t = hub.getTrack(songId)
  const stems = hasStems(songId)
  const pitch = hasPitch(songId)
  if (stems) {
    if (!!t.hasPitch !== pitch) hub.setTrack(songId, { hasPitch: pitch }, false)
    return
  }
  const original = !!findOriginal(songId)
  // 'ready' with stems, or 'ready' on the original alone (separation unavailable) whose original went.
  if (t.status === 'ready' && (t.hasStems || !original)) {
    hub.setTrack(songId, { status: 'idle', progress: 0, hasStems: false, hasPitch: pitch, message: undefined })
  } else if (t.hasPitch !== pitch) {
    hub.setTrack(songId, { hasPitch: pitch }, false)
  }
  if (hub.getTrack(songId).status === 'idle' && !original) hub.forgetTrack(songId)
}

/** At startup: tracks whose files went missing while the server was down. */
export function syncAllTracksFromDisk(): void {
  for (const id of [...hub.tracks.keys()]) syncTrackFromDisk(id)
}

function afterRemoval(songIds: Iterable<number>, mvIds: Iterable<number> = []): void {
  const songs = [...new Set(songIds)]
  for (const id of songs) syncTrackFromDisk(id)
  hub.emit('media-removed', { songIds: songs, mvIds: [...new Set(mvIds)] })
}

// ---------- reading ----------

function mediaGroups(scan: CacheScan, keep: ReturnType<typeof keepers>): CacheGroup[] {
  const groups = new Map<MediaCacheKind, CacheGroup>(
    MEDIA_CACHE_KINDS.map((kind) => [kind, { kind, bytes: 0, count: 0, protectedBytes: 0 }]),
  )
  const now = Date.now()
  const add = (f: CacheFile, kept: boolean) => {
    const g = groups.get(f.kind)!
    g.bytes += f.bytes
    g.count++
    if (kept) g.protectedBytes += f.bytes
  }
  for (const s of scan.songs) {
    const kept = keep.songs.has(s.songId)
    for (const f of s.files) add(f, f.kind === 'temp' ? !isLeftover(f, now) : kept)
  }
  for (const m of scan.mvs) add(m.file, keep.mvs.has(m.mvId))
  for (const f of scan.loose) add(f, !isLeftover(f, now))
  return [...groups.values()]
}

export async function cacheInfo(): Promise<CacheInfo> {
  const scan = await scanCache()
  const keep = keepers()
  return {
    usedBytes: totalBytes(scan),
    limitBytes: getSettings().cacheLimitGB * GB,
    songs: scan.songs.filter((s) => s.files.some((f) => f.kind !== 'temp')).length,
    mvs: scan.mvs.length,
    media: mediaGroups(scan, keep),
    data: dataCacheGroups(),
  }
}

const KEY_RE = /_([+-]?\d+)\.flac$/

/** Every cached song with its size per kind, biggest first. */
export async function listCachedSongs(): Promise<CachedSongInfo[]> {
  const scan = await scanCache()
  const keep = keepers()
  const mvBytes = new Map<number, number>()
  for (const m of scan.mvs) mvBytes.set(m.mvId, (mvBytes.get(m.mvId) ?? 0) + m.file.bytes)
  const list: CachedSongInfo[] = []
  for (const s of scan.songs) {
    if (!s.files.length) continue
    const kinds: Partial<Record<MediaCacheKind, number>> = {}
    const keys = new Set<number>()
    for (const f of s.files) {
      kinds[f.kind] = (kinds[f.kind] ?? 0) + f.bytes
      if (f.kind === 'pitched') {
        const m = KEY_RE.exec(f.rel)
        if (m) keys.add(Number(m[1]))
      }
    }
    const song = getCachedSong(s.songId)
    const mv = song?.mvId ? mvBytes.get(song.mvId) : undefined
    if (mv) kinds.mv = mv
    const why = keep.songs.get(s.songId)
    list.push({
      songId: s.songId,
      name: song?.name,
      artists: song?.artists.map((a) => a.name).join(' / '),
      cover: song?.album.picUrl,
      bytes: s.bytes + (mv ?? 0),
      kinds,
      keys: [...keys].sort((a, b) => a - b),
      lastUsed: s.lastUsed,
      keep: why,
    })
  }
  return list.sort((a, b) => b.bytes - a.bytes)
}

// ---------- clearing ----------

/** Files of one kind that clearing may remove (kept songs / MVs and live writes are skipped). */
function clearable(scan: CacheScan, keep: ReturnType<typeof keepers>, kind: MediaCacheKind): CacheFile[] {
  const now = Date.now()
  if (kind === 'mv') return scan.mvs.filter((m) => !keep.mvs.has(m.mvId)).map((m) => m.file)
  if (kind === 'temp') {
    return [...scan.loose, ...scan.songs.flatMap((s) => s.files.filter((f) => f.kind === 'temp'))].filter((f) =>
      isLeftover(f, now),
    )
  }
  const out: CacheFile[] = []
  for (const s of scan.songs) {
    if (keep.songs.has(s.songId)) continue
    for (const f of s.files) if (f.kind === kind || derivedFrom(kind, f)) out.push(f)
  }
  return out
}

function songIdOf(scan: CacheScan, file: CacheFile): number | undefined {
  return scan.songs.find((s) => file.path.startsWith(s.dir + path.sep))?.songId
}

/** Clear one kind of media; returns bytes freed. */
export async function clearMediaKind(kind: MediaCacheKind): Promise<number> {
  const scan = await scanCache(0)
  const files = clearable(scan, keepers(), kind)
  const freed = await removeFiles(files)
  const songIds = files.map((f) => songIdOf(scan, f)).filter((id): id is number => id !== undefined)
  const mvIds = kind === 'mv' ? scan.mvs.filter((m) => files.includes(m.file)).map((m) => m.mvId) : []
  afterRemoval(songIds, mvIds)
  console.log(`[cache] cleared ${kind}: ${files.length} files, ${(freed / 1024 ** 2).toFixed(0)} MB`)
  return freed
}

/** Clear all media that isn't kept; returns bytes freed. */
export async function clearAllMedia(): Promise<number> {
  const scan = await scanCache(0)
  const keep = keepers()
  let freed = 0
  const removed: number[] = []
  for (const s of scan.songs) {
    if (keep.songs.has(s.songId)) continue
    await removeSongDir(s.songId)
    freed += s.bytes
    removed.push(s.songId)
  }
  const mvs = scan.mvs.filter((m) => !keep.mvs.has(m.mvId))
  freed += await removeFiles([...mvs.map((m) => m.file), ...clearable(scan, keep, 'temp')])
  afterRemoval(removed, mvs.map((m) => m.mvId))
  console.log(`[cache] cleared all media: ${removed.length} songs, ${mvs.length} MVs`)
  return freed
}

/** Clear one song's media (some kinds, or everything including its MV); returns bytes freed. */
export async function clearSongMedia(songId: number, kinds?: MediaCacheKind[]): Promise<number> {
  const keep = keepers()
  const why = keep.songs.get(songId)
  if (why) {
    const reasons: Record<Keep, string> = {
      playing: '正在唱的歌不能清理',
      queued: '已点的歌不能清理',
      'idle-music': '这首歌在待机音乐里，先从待机音乐中移除',
      busy: '这首歌正在处理中，稍后再试',
    }
    throw new CacheError(reasons[why])
  }
  const scan = await scanCache(0)
  const entry = scan.songs.find((s) => s.songId === songId)
  const mvId = getCachedSong(songId)?.mvId
  const mvFiles = mvId && !keep.mvs.has(mvId) ? scan.mvs.filter((m) => m.mvId === mvId).map((m) => m.file) : []
  let freed = 0
  if (!kinds) {
    if (entry) {
      await removeSongDir(songId)
      freed += entry.bytes
    }
    freed += await removeFiles(mvFiles)
  } else {
    const files = (entry?.files ?? []).filter((f) => kinds.some((k) => f.kind === k || derivedFrom(k, f)))
    freed += await removeFiles([...files, ...(kinds.includes('mv') ? mvFiles : [])])
  }
  afterRemoval([songId], mvFiles.length && (!kinds || kinds.includes('mv')) && mvId ? [mvId] : [])
  return freed
}

/** Clear cached NetEase data: one kind, or all of it. Returns rows affected. */
export function clearData(kind?: DataCacheKind): number {
  clearLinks()
  return kind ? clearDataKind(kind) : clearApiCache()
}

// ---------- the limit ----------

let enforcing: Promise<void> | null = null
let again = false

/** Evict until the cache fits settings.cacheLimitGB (cheapest to rebuild first, then LRU). */
export function enforceCacheLimit(): Promise<void> {
  if (enforcing) {
    again = true
    return enforcing
  }
  enforcing = (async () => {
    try {
      do {
        again = false
        await evict()
      } while (again)
    } catch (err) {
      console.warn('[cache] enforce failed:', (err as Error).message)
    } finally {
      enforcing = null
    }
  })()
  return enforcing
}

async function evict(): Promise<void> {
  const limit = getSettings().cacheLimitGB * GB
  const scan = await scanCache(0)
  let used = totalBytes(scan)
  if (used <= limit) return
  const keep = keepers()
  const removedSongs = new Set<number>()
  const removedMvs = new Set<number>()
  const freedIn = new Map<number, number>()
  const log = (what: string, bytes: number) => console.log(`[cache] evicted ${what} (${(bytes / 1024 ** 2).toFixed(0)} MB)`)

  // 1. Leftovers of unfinished writes.
  const leftovers = clearable(scan, keep, 'temp')
  if (leftovers.length) {
    const freed = await removeFiles(leftovers)
    used -= freed
    log(`${leftovers.length} leftover files`, freed)
  }

  // 2a. MVs cached at another resolution than the one now chosen (re-downloaded at the new one).
  if (used > limit) {
    const res = getSettings().mvResolution
    for (const m of scan.mvs.filter((x) => x.res !== res && !keep.mvs.has(x.mvId)).sort((a, b) => a.file.mtime - b.file.mtime)) {
      if (used <= limit) break
      used -= await removeFiles([m.file])
      removedMvs.add(m.mvId)
      log(`mv ${m.mvId} at ${m.res}P`, m.file.bytes)
    }
  }

  // 2b. Key-shift renders, oldest first.
  if (used > limit) {
    const renders = scan.songs
      .filter((s) => !keep.songs.has(s.songId))
      .flatMap((s) => s.files.filter((f) => f.kind === 'pitched').map((f) => ({ f, songId: s.songId, at: Math.max(f.mtime, s.lastUsed) })))
      .sort((a, b) => a.at - b.at)
    for (const r of renders) {
      if (used <= limit) break
      const freed = await removeFiles([r.f])
      used -= freed
      freedIn.set(r.songId, (freedIn.get(r.songId) ?? 0) + freed)
      removedSongs.add(r.songId)
    }
    if (removedSongs.size) log(`key-shift renders of ${removedSongs.size} songs`, [...freedIn.values()].reduce((a, b) => a + b, 0))
  }

  // 3. Whole songs and MVs, least recently used first.
  if (used > limit) {
    type Candidate = { lastUsed: number; bytes: number; what: string; remove: () => Promise<void> }
    const candidates: Candidate[] = [
      ...scan.songs
        .filter((s) => !keep.songs.has(s.songId))
        .map((s) => ({
          lastUsed: s.lastUsed,
          bytes: s.bytes - (freedIn.get(s.songId) ?? 0),
          what: `song ${s.songId}`,
          remove: async () => {
            await removeSongDir(s.songId)
            removedSongs.add(s.songId)
          },
        })),
      ...scan.mvs
        .filter((m) => !keep.mvs.has(m.mvId) && !removedMvs.has(m.mvId))
        .map((m) => ({
          lastUsed: m.file.mtime,
          bytes: m.file.bytes,
          what: `mv ${m.mvId}`,
          remove: async () => {
            await removeFiles([m.file])
            removedMvs.add(m.mvId)
          },
        })),
    ].sort((a, b) => a.lastUsed - b.lastUsed)
    for (const c of candidates) {
      if (used <= limit) break
      await c.remove()
      used -= c.bytes
      log(c.what, c.bytes)
    }
  }
  afterRemoval(removedSongs, removedMvs)
}
