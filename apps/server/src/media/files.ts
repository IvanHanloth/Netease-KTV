import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { paths } from '../config.js'
import type { MediaCacheKind, MvResolution, Stem } from '../shared/types.js'

/**
 * The on-disk layout of the media cache, in one place:
 *
 *   media/<songId>/original.<ext>             原曲 (download)
 *   media/<songId>/instrumental.flac, vocals.flac   伴奏 / 人声 (separation)
 *   media/<songId>/pitch.json, mv_align.json  评分音高 / MV 对齐 (analysis)
 *   media/<songId>/pitch/<stem>_<±key>.flac   变调 (ffmpeg)
 *   media/<songId>/.access                    last use (LRU)
 *   mv/<mvId>_<res>.mp4                       MV
 *   tmp/                                      scratch files
 *   *.part                                    unfinished writes
 *
 * Path helpers are pure: only writers create directories (ensureMediaDir), so looking up a song
 * that was never downloaded leaves nothing behind.
 */

export const ACCESS_MARK = '.access'
const PARTIAL = /\.part(\.\w+)?$/

/** media/<songId>/, created. For writers only. */
export function ensureMediaDir(songId: number): string {
  const dir = paths.media(songId)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function stemPath(songId: number, stem: 'instrumental' | 'vocals'): string {
  return path.join(paths.media(songId), `${stem}.flac`)
}

export function originalPath(songId: number, ext: string): string {
  return path.join(paths.media(songId), `original.${ext}`)
}

export function findOriginal(songId: number): string | null {
  const dir = paths.media(songId)
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return null
  }
  const file = names.find((f) => f.startsWith('original.') && !PARTIAL.test(f))
  return file ? path.join(dir, file) : null
}

export function pitchPath(songId: number): string {
  return path.join(paths.media(songId), 'pitch.json')
}

export function alignPath(songId: number): string {
  return path.join(paths.media(songId), 'mv_align.json')
}

export function hasPitch(songId: number): boolean {
  return fs.existsSync(pitchPath(songId))
}

export function hasStems(songId: number): boolean {
  return fs.existsSync(stemPath(songId, 'instrumental')) && fs.existsSync(stemPath(songId, 'vocals'))
}

/** File for a stem at its original key (the caller renders missing pitch-shifted files). */
export function stemFile(songId: number, stem: Stem): string | null {
  if (stem === 'original') return findOriginal(songId)
  const file = stemPath(songId, stem)
  return fs.existsSync(file) ? file : null
}

export function pitchedDir(songId: number): string {
  return path.join(paths.media(songId), 'pitch')
}

export function pitchedPath(songId: number, stem: Stem, key: number): string {
  return path.join(pitchedDir(songId), `${stem}_${key > 0 ? '+' : ''}${key}.flac`)
}

/** Cached MV file for a resolution. */
export function mvPath(mvId: number, res: MvResolution): string {
  return path.join(paths.mvRoot(), `${mvId}_${res}.mp4`)
}

/** `mv/<mvId>_<res>.mp4` → its ids; null for anything else (including .part files). */
export function parseMvFile(name: string): { mvId: number; res: number } | null {
  const m = /^(\d+)_(\d+)\.mp4$/.exec(name)
  return m ? { mvId: Number(m[1]), res: Number(m[2]) } : null
}

export function isPartial(name: string): boolean {
  return PARTIAL.test(name)
}

/**
 * Which cache kind a file inside media/<songId>/ belongs to (`rel` is relative to that dir, with
 * forward slashes). null: the access marker, or a file this version doesn't know.
 */
export function kindOfSongFile(rel: string): MediaCacheKind | null {
  const name = rel.slice(rel.lastIndexOf('/') + 1)
  if (isPartial(name)) return 'temp'
  if (rel.startsWith('pitch/')) return name.endsWith('.flac') ? 'pitched' : null
  if (rel.includes('/')) return null
  if (name.startsWith('original.')) return 'original'
  if (name === 'instrumental.flac' || name === 'vocals.flac') return 'stems'
  if (name === 'pitch.json' || name === 'mv_align.json') return 'analysis'
  return null
}

/** Which stem a pitch-shifted render was made from (`vocals_+2.flac` → vocals). */
export function stemOfPitched(name: string): Stem | null {
  const m = /^(instrumental|vocals|original)_[+-]?\d+\.flac$/.exec(name)
  return m ? (m[1] as Stem) : null
}

/** Remove everything cached for a song (used by retry). */
export function clearMedia(songId: number): void {
  fs.rmSync(paths.media(songId), { recursive: true, force: true })
}

export const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

/** Download a URL to `dest` (through `dest.part`, renamed when complete), reporting progress 0..1. */
export async function download(url: string, dest: string, onProgress?: (p: number) => void): Promise<void> {
  const res = await fetch(url, { headers: { 'User-Agent': BROWSER_UA } })
  if (!res.ok || !res.body) throw new Error(`下载失败：HTTP ${res.status}`)
  const total = Number(res.headers.get('content-length') ?? 0)
  let received = 0
  let lastReport = 0
  const tmp = `${dest}.part`
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  const body = Readable.fromWeb(res.body as any)
  body.on('data', (chunk: Buffer) => {
    received += chunk.length
    const now = Date.now()
    if (total && onProgress && now - lastReport > 300) {
      lastReport = now
      onProgress(Math.min(1, received / total))
    }
  })
  try {
    await pipeline(body, fs.createWriteStream(tmp))
    if (received < 64 * 1024) throw new Error('下载的文件过小，可能不完整')
    fs.renameSync(tmp, dest)
  } catch (err) {
    fs.rmSync(tmp, { force: true })
    throw err
  }
  onProgress?.(1)
}
