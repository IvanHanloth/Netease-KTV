import fsp from 'node:fs/promises'
import path from 'node:path'
import { paths } from '../config.js'
import type { MediaCacheKind } from '../shared/types.js'
import { ACCESS_MARK, isPartial, kindOfSongFile, parseMvFile } from './files.js'

/**
 * The media cache on disk, as data: what is there, how big, when last used. Scans are async
 * (they never block playback) and shared for a few seconds; anything that writes or deletes calls
 * invalidateScan(). Policy (what may be removed, in which order) lives in core/storage.ts.
 */

export interface CacheFile {
  path: string
  kind: MediaCacheKind
  bytes: number
  mtime: number
  /** Relative to its song dir, with forward slashes ('pitch/vocals_+2.flac'); file name otherwise. */
  rel: string
}

export interface SongCache {
  songId: number
  dir: string
  /** Files this version knows (the access marker and unknown files are left out). */
  files: CacheFile[]
  /** Everything in the dir, known or not. */
  bytes: number
  lastUsed: number
}

export interface MvCache {
  mvId: number
  res: number
  file: CacheFile
}

export interface CacheScan {
  songs: SongCache[]
  mvs: MvCache[]
  /** data/tmp/* and unfinished MV downloads. */
  loose: CacheFile[]
}

interface RawFile {
  path: string
  rel: string
  bytes: number
  mtime: number
}

async function walk(dir: string, base = '', out: RawFile[] = []): Promise<RawFile[]> {
  let entries
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    const rel = base ? `${base}/${e.name}` : e.name
    if (e.isDirectory()) await walk(p, rel, out)
    else if (e.isFile()) {
      try {
        const st = await fsp.stat(p)
        out.push({ path: p, rel, bytes: st.size, mtime: st.mtimeMs })
      } catch {
        /* removed meanwhile */
      }
    }
  }
  return out
}

async function scanSongs(): Promise<SongCache[]> {
  const root = paths.mediaRoot()
  let names: string[]
  try {
    names = await fsp.readdir(root)
  } catch {
    return []
  }
  const songs: SongCache[] = []
  for (const name of names) {
    const songId = Number(name)
    if (!Number.isInteger(songId) || songId <= 0) continue
    const dir = path.join(root, name)
    const raw = await walk(dir)
    let lastUsed = 0
    let bytes = 0
    const files: CacheFile[] = []
    for (const f of raw) {
      bytes += f.bytes
      if (f.rel === ACCESS_MARK) {
        lastUsed = Math.max(lastUsed, f.mtime)
        continue
      }
      const kind = kindOfSongFile(f.rel)
      if (kind) files.push({ ...f, kind })
    }
    // Never played (no marker yet): last written.
    if (!lastUsed) lastUsed = raw.reduce((m, f) => Math.max(m, f.mtime), 0)
    songs.push({ songId, dir, files, bytes, lastUsed })
  }
  return songs
}

async function scanMvs(): Promise<{ mvs: MvCache[]; parts: CacheFile[] }> {
  const mvs: MvCache[] = []
  const parts: CacheFile[] = []
  for (const f of await walk(paths.mvRoot())) {
    if (f.rel.includes('/')) continue
    const id = parseMvFile(f.rel)
    if (id) mvs.push({ mvId: id.mvId, res: id.res, file: { ...f, kind: 'mv' } })
    else if (isPartial(f.rel)) parts.push({ ...f, kind: 'temp' })
  }
  return { mvs, parts }
}

async function doScan(): Promise<CacheScan> {
  const [songs, mv, tmp] = await Promise.all([scanSongs(), scanMvs(), walk(paths.tmp())])
  return { songs, mvs: mv.mvs, loose: [...mv.parts, ...tmp.map((f) => ({ ...f, kind: 'temp' as const }))] }
}

const MEMO_MS = 10_000
let memo: { at: number; scan: Promise<CacheScan> } | null = null

/** The cache contents, at most `maxAgeMs` old. */
export function scanCache(maxAgeMs = MEMO_MS): Promise<CacheScan> {
  if (memo && Date.now() - memo.at < maxAgeMs) return memo.scan
  const scan = doScan()
  const entry = { at: Date.now(), scan }
  memo = entry
  scan.catch(() => {
    if (memo === entry) memo = null
  })
  return scan
}

/** Something was written or deleted: the next scan reads the disk again. */
export function invalidateScan(): void {
  memo = null
}

/** Delete files; returns the bytes freed. Song dirs left with nothing in them are removed too. */
export async function removeFiles(files: CacheFile[]): Promise<number> {
  let freed = 0
  const dirs = new Set<string>()
  for (const f of files) {
    try {
      await fsp.rm(f.path, { force: true })
      freed += f.bytes
      dirs.add(path.dirname(f.path))
    } catch {
      /* in use or gone */
    }
  }
  for (const dir of dirs) await removeIfEmpty(dir)
  invalidateScan()
  return freed
}

/** Remove a dir under media/ that holds nothing but the access marker, then its parent likewise. */
async function removeIfEmpty(dir: string): Promise<void> {
  const mediaRoot = path.resolve(paths.mediaRoot())
  let current = path.resolve(dir)
  while (current.startsWith(mediaRoot + path.sep)) {
    let names: string[]
    try {
      names = await fsp.readdir(current)
    } catch {
      return
    }
    if (names.some((n) => n !== ACCESS_MARK)) return
    await fsp.rm(current, { recursive: true, force: true }).catch(() => {})
    current = path.dirname(current)
  }
}

export async function removeSongDir(songId: number): Promise<void> {
  await fsp.rm(paths.media(songId), { recursive: true, force: true })
  invalidateScan()
}

// ---------- LRU marks ----------

const TOUCH_EVERY_MS = 60_000
const touched = new Map<string, number>()

function due(key: string): boolean {
  const now = Date.now()
  if (now - (touched.get(key) ?? 0) < TOUCH_EVERY_MS) return false
  if (touched.size > 2000) touched.clear()
  touched.set(key, now)
  return true
}

/**
 * Remember that a song's files were just used (LRU). Cheap enough for every media request: at
 * most once a minute per song, async, and it never creates the song dir.
 */
export function touchSong(songId: number): void {
  if (!due(`song:${songId}`)) return
  const mark = path.join(paths.media(songId), ACCESS_MARK)
  const now = new Date()
  void fsp.utimes(mark, now, now).catch(() => fsp.writeFile(mark, '').catch(() => {}))
}

export function touchFile(file: string): void {
  if (!due(file)) return
  const now = new Date()
  void fsp.utimes(file, now, now).catch(() => {})
}
