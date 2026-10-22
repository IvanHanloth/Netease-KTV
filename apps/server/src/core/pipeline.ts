import fs from 'node:fs'
import path from 'node:path'
import { config } from '../config.js'
import { probeDuration } from '../media/ffmpeg.js'
import { clearMedia, download, findOriginal, hasStems, mediaDir } from '../media/files.js'
import { resolveAudio, UnavailableError } from '../media/resolve.js'
import { getSong } from '../ncm/service.js'
import { getJob, separatorHealth, submitJob } from '../separator.js'
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
  if (track.status !== 'idle') return
  if (hasStems(songId)) hub.setTrack(songId, { status: 'ready', progress: 1, hasStems: true })
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
    for (;;) {
      await sleep(1000)
      const job = await getJob(jobId)
      if (job.status === 'done') break
      if (job.status === 'error') throw new Error(job.error || '分离失败')
      hub.setTrack(songId, { status: 'separating', progress: job.progress ?? 0 }, false)
    }
    if (!hasStems(songId)) throw new Error('分离服务没有生成伴奏文件')
    hub.setTrack(songId, { status: 'ready', progress: 1, hasStems: true, message: undefined })
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

async function separateLoop(): Promise<void> {
  if (separating) return
  separating = true
  try {
    let id: number | undefined
    while ((id = nextWith('queued')) !== undefined) {
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
  const pending = priorityIds().filter((id) => {
    const s = hub.getTrack(id).status
    return s === 'queued' || s === 'separating' || s === 'downloading' || s === 'idle'
  }).length
  hub.setSeparator({
    online: !!health?.ok,
    device: health?.device,
    model: health?.model,
    pending,
  })
}

export function retry(songId: number): void {
  clearMedia(songId)
  hub.setTrack(songId, { status: 'idle', progress: 0, hasStems: false, message: undefined, source: undefined })
  hub.emit('work')
}

export function startPipeline(): void {
  hub.on('work', () => {
    void downloadLoop()
    void separateLoop()
    void pollSeparator()
  })
  hub.on('work-separate', () => void separateLoop())
  void pollSeparator().then(() => hub.emit('work'))
  setInterval(() => void pollSeparator(), 5000).unref()
}
