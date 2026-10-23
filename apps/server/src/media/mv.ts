import fs from 'node:fs'
import path from 'node:path'
import { paths } from '../config.js'
import { mvUrl } from '../ncm/service.js'
import { alignOnCluster } from '../separator.js'
import { getSettings } from '../settings.js'
import { MV_RESOLUTIONS } from '../shared/constants.js'
import type { Song } from '../shared/types.js'
import { singleFlight } from '../util.js'
import { busyMv, busySong } from './busy.js'
import { invalidateScan } from './cache.js'
import { extractAnalysisWav } from './ffmpeg.js'
import { alignPath, download, ensureMediaDir, findOriginal, mvPath } from './files.js'

/** Best cached file: the configured resolution first, then any other one. */
export function cachedMv(mvId: number): string | null {
  const preferred = getSettings().mvResolution
  for (const res of [preferred, ...MV_RESOLUTIONS.filter((r) => r !== preferred).reverse()]) {
    const p = mvPath(mvId, res)
    if (fs.existsSync(p)) return p
  }
  return null
}

const downloads = singleFlight<number, string>()

/** Download an MV into the cache (once; concurrent callers share the download). */
export function ensureMv(mvId: number): Promise<string> {
  const existing = cachedMv(mvId)
  if (existing) return Promise.resolve(existing)
  return downloads(mvId, () =>
    busyMv(
      mvId,
      (async () => {
        const res = getSettings().mvResolution
        const dest = mvPath(mvId, res)
        await download(await mvUrl(mvId, res), dest)
        invalidateScan()
        return dest
      })(),
    ),
  )
}

// ---------- alignment (videoTime = audioTime + offset) ----------

export interface MvAlignment {
  mvId: number
  offset: number
  confidence: number
}

export function readAlignment(songId: number, mvId: number): MvAlignment | null {
  try {
    const a = JSON.parse(fs.readFileSync(alignPath(songId), 'utf8')) as MvAlignment
    return a.mvId === mvId ? a : null
  } catch {
    return null
  }
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
  let finished: () => void = () => {}
  void busySong(song.id, new Promise<void>((resolve) => (finished = resolve)))
  const tmp = paths.tmp()
  fs.mkdirSync(tmp, { recursive: true })
  const songWav = path.join(tmp, `${song.id}_song.wav`)
  const mvWav = path.join(tmp, `${song.mvId}_mv.wav`)
  try {
    await extractAnalysisWav(original, songWav)
    await extractAnalysisWav(mv, mvWav)
    const raw = await alignOnCluster(song.id, songWav, mvWav, song.duration)
    ensureMediaDir(song.id)
    const result: MvAlignment = { mvId: song.mvId, offset: raw.offset, confidence: raw.confidence }
    fs.writeFileSync(alignPath(song.id), JSON.stringify(result))
    console.log(`[mv] song ${song.id} aligned: offset ${result.offset.toFixed(2)}s, confidence ${result.confidence.toFixed(2)}`)
    return result
  } finally {
    aligning.delete(song.id)
    fs.rmSync(songWav, { force: true })
    fs.rmSync(mvWav, { force: true })
    invalidateScan()
    finished()
  }
}
