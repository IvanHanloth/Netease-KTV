import fs from 'node:fs'
import path from 'node:path'
import { config } from '../config.js'
import { probeDuration } from '../media/ffmpeg.js'
import { clearMedia, download, findOriginal, hasPitch, hasStems, mediaDir, stemPath } from '../media/files.js'
import { resolveAudio, UnavailableError } from '../media/resolve.js'
import { enforceCacheLimit } from '../media/cache.js'
import { cachedMv, ensureAlignment, ensureMv, readAlignment } from '../media/mv.js'
import { getCachedSong, getSong } from '../ncm/service.js'
import { pollJob, separatorHealth, submitJob } from '../separator.js'
import { getSettings } from '../settings.js'
import { hub } from './hub.js'
import { priorityIds } from './player.js'

/**
 * Prepares accompaniment for queued songs, in queue order:
 *   idle -> downloading -> queued -> separating -> ready
 * Downloads and separation run in two independent loops so the next song can
 * download while the GPU is busy.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const bootAt = Date.now()

let downloading = false
let separating = false

function nextWith(status: string): number | undefined {
  return priorityIds().find((id) => hub.getTrack(id).status === status)
}

/** Recognize songs that were fully processed in an earlier session. */
function reconcile(songId: number): void {
  const track = hub.getTrack(songId)
  // Stems that appeared after the song was marked "original only".
  if (track.status === 'ready' && !track.hasStems && hasStems(songId)) {
    hub.setTrack(songId, { hasStems: true, hasPitch: hasPitch(songId), message: undefined })
    return
  }
  if (track.status !== 'idle') return
  if (hasStems(songId)) {
    hub.setTrack(songId, { status: 'ready', progress: 1, hasStems: true, hasPitch: hasPitch(songId) })
  }
  else if (findOriginal(songId)) hub.setTrack(songId, { status: 'queued', progress: 0, hasStems: false })
}

async function downloadOne(songId: number): Promise<void> {
  hub.setTrack(songId, { status: 'downloading', progress: 0, message: undefined }, false)
  try {
    const song = await getSong(songId)
    const audio = await resolveAudio(song)
    const dest = path.join(mediaDir(songId), `original.${audio.ext}`)
    await download(audio.url, dest, (p) => hub.setTrack(songId, { progress: p }, false))

    if (audio.source === 'unblock' && song.duration > 0) {
      const actual = await probeDuration(dest)
      if (actual > 0 && Math.abs(actual - song.duration) > config.unblockDurationTolerance) {
        fs.rmSync(dest, { force: true })
        throw new UnavailableError('no-source', '第三方音源与原曲时长不一致，可能是其他版本')
      }
    }
    hub.setTrack(songId, { status: 'queued', progress: 0, source: audio.source, hasStems: false })
    enforceCacheLimit()
    hub.emit('work-mv')
  } catch (err) {
    if (err instanceof UnavailableError) {
      hub.setTrack(songId, { status: 'unavailable', progress: 0, message: err.message })
      hub.emit('unavailable', songId)
    } else {
      console.error(`[pipeline] download ${songId} failed:`, err)
      hub.setTrack(songId, { status: 'error', progress: 0, message: (err as Error).message })
    }
  }
}

async function downloadLoop(): Promise<void> {
  if (downloading) return
  downloading = true
  try {
    for (const id of priorityIds()) reconcile(id)
    let id: number | undefined
    while ((id = nextWith('idle')) !== undefined) {
      await downloadOne(id)
      hub.emit('work-separate')
    }
  } finally {
    downloading = false
  }
  hub.emit('work-separate')
}

async function separateOne(songId: number): Promise<void> {
  const input = findOriginal(songId)
  if (!input) {
    hub.setTrack(songId, { status: 'idle' })
    return
  }
  const song = await getSong(songId).catch(() => null)
  hub.setTrack(songId, { status: 'separating', progress: 0, message: undefined }, false)
  try {
    const { id: jobId } = await submitJob({
      songId,
      input,
      outputDir: mediaDir(songId),
      durationMs: song?.duration ?? 0,
      model: getSettings().separatorModel,
    })
    const job = await pollJob(
      jobId,
      (j) => j.status === 'done' || !!j.stems_ready,
      (j) => hub.setTrack(songId, { status: 'separating', progress: j.progress ?? 0 }, false),
    )
    if (!hasStems(songId)) throw new Error('分离服务没有生成伴奏文件')
    // Playable now; the pitch track (for scoring) may still be computing.
    hub.setTrack(songId, {
      status: 'ready',
      progress: 1,
      hasStems: true,
      hasPitch: hasPitch(songId),
      message: undefined,
    })
    enforceCacheLimit()
    if (job.status !== 'done') {
      pitchTried.add(songId)
      void waitForPitch(jobId, songId)
    }
  } catch (err) {
    console.error(`[pipeline] separate ${songId} failed:`, err)
    // Still playable with the original audio.
    hub.setTrack(songId, {
      status: 'ready',
      progress: 1,
      hasStems: false,
      message: `伴奏生成失败，将播放原曲：${(err as Error).message}`,
    })
  }
}

const pitchTried = new Set<number>()

/** Songs separated before scoring existed (or whose pitch step failed) get their pitch extracted once. */
function nextNeedingPitch(): number | undefined {
  return priorityIds().find((id) => {
    const t = hub.getTrack(id)
    return t.status === 'ready' && t.hasStems && !t.hasPitch && !pitchTried.has(id)
  })
}

async function pitchOne(songId: number): Promise<void> {
  pitchTried.add(songId)
  try {
    const { id: jobId } = await submitJob({
      songId,
      input: stemPath(songId, 'vocals'),
      outputDir: mediaDir(songId),
      durationMs: 0,
      mode: 'pitch',
    })
    await waitForPitch(jobId, songId)
  } catch (err) {
    console.warn(`[pipeline] pitch ${songId} failed:`, (err as Error).message)
  }
}

/** Wait (in the background) for a job's pitch step and flag the track when it lands. */
async function waitForPitch(jobId: string, songId: number): Promise<void> {
  try {
    await pollJob(jobId, (j) => j.status === 'done', undefined, 300)
  } catch (err) {
    console.warn(`[pipeline] pitch ${songId} failed:`, (err as Error).message)
  }
  if (hasPitch(songId)) hub.setTrack(songId, { hasPitch: true }, false)
}

async function separateLoop(): Promise<void> {
  if (separating) return
  separating = true
  try {
    for (;;) {
      const id = nextWith('queued')
      if (id === undefined) {
        const pid = hub.separator.online ? nextNeedingPitch() : undefined
        if (pid === undefined) break
        await pitchOne(pid)
        continue
      }
      if (!hub.separator.online) {
        // Give a separator container that is still loading its model a moment.
        if (Date.now() - bootAt < 45_000) {
          await sleep(3000)
          await pollSeparator()
          continue
        }
        // No separator: play the original instead of waiting forever.
        hub.setTrack(id, {
          status: 'ready',
          progress: 1,
          hasStems: false,
          message: '分离服务离线，将播放原曲',
        })
        continue
      }
      await separateOne(id)
    }
  } finally {
    separating = false
  }
}

async function pollSeparator(): Promise<void> {
  const health = await separatorHealth()
  const wasOnline = hub.separator.online
  const pending = priorityIds().filter((id) => {
    const s = hub.getTrack(id).status
    return s === 'queued' || s === 'separating' || s === 'downloading' || s === 'idle'
  }).length
  hub.setSeparator({
    online: !!health?.ok,
    ready: health ? (health.ready ?? true) : false,
    device: health?.device,
    model: health?.model,
    pending,
  })
  // The separator just came (back) online: pick up queued songs and pitch backfills.
  if (!wasOnline && health?.ok) {
    hub.emit('work-separate')
    hub.emit('work-mv')
  }
}

export function retry(songId: number): void {
  clearMedia(songId)
  hub.setTrack(songId, { status: 'idle', progress: 0, hasStems: false, message: undefined, source: undefined })
  hub.emit('work')
}

// ---------- MV preload + alignment ----------

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
        enforceCacheLimit()
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

export function startPipeline(): void {
  hub.on('work', () => {
    void downloadLoop()
    void separateLoop()
    void pollSeparator()
    void mvLoop()
  })
  hub.on('work-separate', () => void separateLoop())
  hub.on('work-mv', () => void mvLoop())
  setTimeout(enforceCacheLimit, 10_000).unref()
  // Safety net: pick up MV work that was skipped while the separator was still starting.
  setInterval(() => hub.emit('work-mv'), 60_000).unref()
  void pollSeparator().then(() => hub.emit('work'))
  setInterval(() => void pollSeparator(), 5000).unref()
}
