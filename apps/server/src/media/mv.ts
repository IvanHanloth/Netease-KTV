import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { config, paths } from '../config.js'
import { mvUrl } from '../ncm/service.js'
import { pollJob, submitJob } from '../separator.js'
import { getSettings } from '../settings.js'
import type { MvResolution, Song } from '../shared/types.js'
import { download, findOriginal, mediaDir } from './files.js'

/** Cached MV file for a resolution. */
export function mvPath(mvId: number, res: MvResolution): string {
  return path.join(paths.mvRoot(), `${mvId}_${res}.mp4`)
}

/** Best cached file: the configured resolution first, then any other one. */
export function cachedMv(mvId: number): string | null {
  const preferred = getSettings().mvResolution
  for (const res of [preferred, 720, 1080, 480] as MvResolution[]) {
    const p = mvPath(mvId, res)
    if (fs.existsSync(p)) return p
  }
  return null
}

const inflight = new Map<number, Promise<string>>()

/** Download an MV into the cache (once; concurrent callers share the download). */
export function ensureMv(mvId: number): Promise<string> {
  const existing = cachedMv(mvId)
  if (existing) return Promise.resolve(existing)
  const running = inflight.get(mvId)
  if (running) return running
  const job = (async () => {
    const res = getSettings().mvResolution
    fs.mkdirSync(paths.mvRoot(), { recursive: true })
    const dest = mvPath(mvId, res)
    await download(await mvUrl(mvId, res), dest)
    return dest
  })().finally(() => inflight.delete(mvId))
  inflight.set(mvId, job)
  return job
}

// ---------- alignment (videoTime = audioTime + offset) ----------

export interface MvAlignment {
  mvId: number
  offset: number
  confidence: number
}

const alignPath = (songId: number) => path.join(paths.media(songId), 'mv_align.json')

export function readAlignment(songId: number, mvId: number): MvAlignment | null {
  try {
    const a = JSON.parse(fs.readFileSync(alignPath(songId), 'utf8')) as MvAlignment
    return a.mvId === mvId ? a : null
  } catch {
    return null
  }
}

function toWav(input: string, output: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // 11.025 kHz mono, first 15 minutes: plenty for onset / chroma matching.
    const child = spawn(
      config.ffmpeg,
      ['-y', '-v', 'error', '-i', input, '-vn', '-ac', '1', '-ar', '11025', '-t', '900', output],
      { windowsHide: true },
    )
    let err = ''
    child.stderr.on('data', (d) => (err += d))
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg: ${err.slice(-300)}`))))
  })
}

const aligning = new Set<number>()

/**
 * Compute the MV ↔ song offset with the separator (onset + chroma cross-correlation).
 * Needs the song's original audio and the cached MV. Result lands in media/<songId>/mv_align.json.
 */
export async function ensureAlignment(song: Song): Promise<MvAlignment | null> {
  if (!song.mvId) return null
  const done = readAlignment(song.id, song.mvId)
  if (done) return done
  const original = findOriginal(song.id)
  const mv = cachedMv(song.mvId)
  if (!original || !mv || aligning.has(song.id)) return null
  aligning.add(song.id)
  const tmp = paths.tmp()
  fs.mkdirSync(tmp, { recursive: true })
  const songWav = path.join(tmp, `${song.id}_song.wav`)
  const mvWav = path.join(tmp, `${song.mvId}_mv.wav`)
  try {
    await toWav(original, songWav)
    await toWav(mv, mvWav)
    const { id } = await submitJob({
      songId: song.id,
      input: songWav,
      input2: mvWav,
      outputDir: mediaDir(song.id),
      durationMs: song.duration,
      mode: 'align',
    })
    await pollJob(id, (j) => j.status === 'done', undefined, 120)
    const raw = JSON.parse(fs.readFileSync(alignPath(song.id), 'utf8')) as { offset: number; confidence: number }
    const result: MvAlignment = { mvId: song.mvId, offset: raw.offset, confidence: raw.confidence }
    fs.writeFileSync(alignPath(song.id), JSON.stringify(result))
    console.log(`[mv] song ${song.id} aligned: offset ${result.offset.toFixed(2)}s, confidence ${result.confidence.toFixed(2)}`)
    return result
  } finally {
    aligning.delete(song.id)
    fs.rmSync(songWav, { force: true })
    fs.rmSync(mvWav, { force: true })
  }
}
