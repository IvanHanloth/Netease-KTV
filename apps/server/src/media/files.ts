import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { paths } from '../config.js'
import type { Stem } from '../shared/types.js'

export function mediaDir(songId: number): string {
  const dir = paths.media(songId)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function stemPath(songId: number, stem: 'instrumental' | 'vocals'): string {
  return path.join(mediaDir(songId), `${stem}.flac`)
}

export function findOriginal(songId: number): string | null {
  const dir = paths.media(songId)
  if (!fs.existsSync(dir)) return null
  const file = fs.readdirSync(dir).find((f) => f.startsWith('original.') && !f.endsWith('.part'))
  return file ? path.join(dir, file) : null
}

export function hasStems(songId: number): boolean {
  return fs.existsSync(stemPath(songId, 'instrumental')) && fs.existsSync(stemPath(songId, 'vocals'))
}

/** File for a stem, optionally pitch-shifted (the caller renders missing pitch files). */
export function stemFile(songId: number, stem: Stem): string | null {
  if (stem === 'original') return findOriginal(songId)
  const file = stemPath(songId, stem)
  return fs.existsSync(file) ? file : null
}

export function pitchedPath(songId: number, stem: Stem, key: number): string {
  const dir = path.join(mediaDir(songId), 'pitch')
  fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, `${stem}_${key > 0 ? '+' : ''}${key}.flac`)
}

/** Remove everything cached for a song (used by retry). */
export function clearMedia(songId: number): void {
  fs.rmSync(paths.media(songId), { recursive: true, force: true })
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

/** Download a URL to `dest`, reporting progress 0..1. */
export async function download(url: string, dest: string, onProgress?: (p: number) => void): Promise<void> {
  const res = await fetch(url, { headers: { 'User-Agent': UA } })
  if (!res.ok || !res.body) throw new Error(`下载失败：HTTP ${res.status}`)
  const total = Number(res.headers.get('content-length') ?? 0)
  let received = 0
  let lastReport = 0
  const tmp = `${dest}.part`
  const body = Readable.fromWeb(res.body as any)
  body.on('data', (chunk: Buffer) => {
    received += chunk.length
    const now = Date.now()
    if (total && onProgress && now - lastReport > 300) {
      lastReport = now
      onProgress(Math.min(1, received / total))
    }
  })
  await pipeline(body, fs.createWriteStream(tmp))
  if (received < 64 * 1024) {
    fs.rmSync(tmp, { force: true })
    throw new Error('下载的音频文件过小，可能不是完整歌曲')
  }
  fs.renameSync(tmp, dest)
  onProgress?.(1)
}
