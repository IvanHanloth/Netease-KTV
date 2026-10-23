import { cachedMv, ensureAlignment, ensureMv, readAlignment } from '../media/mv.js'
import { findOriginal } from '../media/files.js'
import { getCachedSong } from '../ncm/service.js'
import { getSettings } from '../settings.js'
import { hub } from './hub.js'
import { priorityIds } from './player.js'
import { enforceCacheLimit } from './storage.js'

/**
 * MV preload (when 预载 MV is on): for queued songs, in queue order, download the MV and then
 * align it to the song (separator job), one at a time. Runs on 'work' / 'work-mv'.
 */


let mvBusy = false
const mvFailedAt = new Map<number, number>()
const alignTried = new Set<string>()

/** Next piece of MV work for queued songs (in queue order): download the MV, then align it. */
async function mvStep(): Promise<boolean> {
  for (const id of priorityIds()) {
    const song = getCachedSong(id)
    if (!song?.mvId) continue
    if (!cachedMv(song.mvId)) {
      if (Date.now() - (mvFailedAt.get(song.mvId) ?? 0) < 10 * 60_000) continue
      try {
        await ensureMv(song.mvId)
        void enforceCacheLimit()
      } catch (err) {
        mvFailedAt.set(song.mvId, Date.now())
        console.warn(`[mv] download ${song.mvId} failed:`, (err as Error).message)
      }
      return true
    }
    const key = `${id}:${song.mvId}`
    if (hub.separator.online && findOriginal(id) && !alignTried.has(key) && !readAlignment(id, song.mvId)) {
      alignTried.add(key)
      try {
        await ensureAlignment(song)
      } catch (err) {
        console.warn(`[mv] align ${id} failed:`, (err as Error).message)
      }
      return true
    }
  }
  return false
}

async function mvLoop(): Promise<void> {
  if (mvBusy || !getSettings().mvPreload) return
  mvBusy = true
  try {
    while (getSettings().mvPreload && (await mvStep())) {
      // keep going until every queued MV is cached and aligned
    }
  } finally {
    mvBusy = false
  }
}

/** Forget that this song's alignment was tried (its files were removed or are being redone). */
export function forgetAlignment(songId: number): void {
  for (const key of alignTried) if (key.startsWith(`${songId}:`)) alignTried.delete(key)
}

export function startMvPreload(): void {
  hub.on('work', () => void mvLoop())
  hub.on('work-mv', () => void mvLoop())
  // Safety net: pick up MV work that was skipped while the separator was still starting.
  setInterval(() => hub.emit('work-mv'), 60_000).unref()
}
