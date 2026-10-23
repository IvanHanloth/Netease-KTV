import fs from 'node:fs'
import path from 'node:path'
import { config } from '../config.js'
import { probeDuration } from '../media/ffmpeg.js'
import { clearMedia, download, findOriginal, hasPitch, hasStems, mediaDir, pitchPath, stemPath } from '../media/files.js'
import { resolveAudio, UnavailableError } from '../media/resolve.js'
import { enforceCacheLimit } from '../media/cache.js'
import { cachedMv, ensureAlignment, ensureMv, readAlignment } from '../media/mv.js'
import { getCachedSong, getSong } from '../ncm/service.js'
import {
  chooseSeparationNode,
  clusterOnline,
  clusterSummary,
  hasNodes,
  NodeError,
  pitchOnCluster,
  pollNodes,
  separateOnNode,
  type SeparatorNodeConfig,
} from '../separator.js'
import { getSettings } from '../settings.js'
import { hub } from './hub.js'
import { priorityIds } from './player.js'

/**
 * Prepares accompaniment for queued songs, in queue order:
 *   idle -> downloading -> queued -> separating -> ready
 * Downloads and separation run independently so the next song can download while the
 * separator nodes are busy; separations are spread over all nodes (see ../separator.ts).
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const bootAt = Date.now()

let downloading = false

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

/** Songs whose separation failed because a node went away: retried on another node. */
const attempts = new Map<number, number>()
const MAX_ATTEMPTS = 3

async function separateOne(songId: number, node: SeparatorNodeConfig): Promise<void> {
  const input = findOriginal(songId)
  if (!input) {
    hub.setTrack(songId, { status: 'idle' })
    return
  }
  // Claim the song synchronously so the dispatcher does not hand it out twice.
  hub.setTrack(songId, { status: 'separating', progress: 0, message: undefined }, false)
  // No await before separateOnNode: it reserves the node slot synchronously, so the dispatcher's
  // next pick in the same pass already sees this node as busy.
  const song = getCachedSong(songId)
  try {
    const { pitch } = await separateOnNode(node, {
      songId,
      songName: song?.name,
      input,
      outDir: mediaDir(songId),
      durationMs: song?.duration ?? 0,
      model: getSettings().separatorModel,
      onProgress: (p) => hub.setTrack(songId, { status: 'separating', progress: p }, false),
    })
    if (!hasStems(songId)) throw new Error('分离服务没有生成伴奏文件')
    attempts.delete(songId)
    // Playable now; the pitch track (for scoring) may still be computing.
    hub.setTrack(songId, {
      status: 'ready',
      progress: 1,
      hasStems: true,
      hasPitch: hasPitch(songId),
      message: undefined,
    })
    enforceCacheLimit()
    pitchTried.add(songId)
    void pitch.then(() => {
      if (hasPitch(songId)) hub.setTrack(songId, { hasPitch: true }, false)
    })
  } catch (err) {
    const n = (attempts.get(songId) ?? 0) + 1
    attempts.set(songId, n)
    const lost = err instanceof NodeError && err.unreachable
    console.error(`[pipeline] separate ${songId} on ${node.name} failed (attempt ${n}):`, (err as Error).message)
    if (lost && n < MAX_ATTEMPTS) {
      // The node dropped out mid-job: give the song to whichever node is up now.
      hub.setTrack(songId, { status: 'queued', progress: 0, message: undefined }, false)
      return
    }
    attempts.delete(songId)
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
let pitchBusy = false

/** Songs separated before scoring existed (or whose pitch step failed) get their pitch extracted once. */
function nextNeedingPitch(): number | undefined {
  return priorityIds().find((id) => {
    const t = hub.getTrack(id)
    return t.status === 'ready' && t.hasStems && !t.hasPitch && !pitchTried.has(id)
  })
}

async function pitchOne(songId: number): Promise<void> {
  pitchTried.add(songId)
  pitchBusy = true
  try {
    if (await pitchOnCluster(songId, stemPath(songId, 'vocals'), pitchPath(songId))) {
      hub.setTrack(songId, { hasPitch: true }, false)
    }
  } catch (err) {
    console.warn(`[pipeline] pitch ${songId} failed:`, (err as Error).message)
  } finally {
    pitchBusy = false
    hub.emit('work-separate')
  }
}

/**
 * Hands queued songs (in queue order) to separator nodes. Several nodes work in parallel; a song
 * waits for a busy fast node when that still beats a free slow one (see chooseSeparationNode).
 * Re-run whenever something changes: a download finishes, a job ends, a node comes online.
 */
function separateLoop(): void {
  for (;;) {
    const id = nextWith('queued')
    if (id === undefined) {
      const pid = !pitchBusy && clusterOnline() ? nextNeedingPitch() : undefined
      if (pid !== undefined) void pitchOne(pid)
      return
    }
    const durationMs = getCachedSong(id)?.duration ?? 0
    const choice = chooseSeparationNode(durationMs)
    if (!choice) {
      // Nothing can take it. Give nodes that are still starting (model download) a moment,
      // otherwise play the original instead of waiting forever.
      const starting = hasNodes() && (Date.now() - bootAt < 45_000 || clusterOnline())
      if (starting) return
      hub.setTrack(id, {
        status: 'ready',
        progress: 1,
        hasStems: false,
        message: hasNodes() ? '分离服务器都不在线，将播放原曲' : '没有配置分离服务器，将播放原曲',
      })
      continue
    }
    if (choice.wait) return
    void separateOne(id, choice.node).finally(() => hub.emit('work-separate'))
  }
}

async function pollSeparator(): Promise<void> {
  const wasOnline = hub.separator.online
  await pollNodes()
  const summary = clusterSummary()
  const pending = priorityIds().filter((id) => {
    const s = hub.getTrack(id).status
    return s === 'queued' || s === 'separating' || s === 'downloading' || s === 'idle'
  }).length
  hub.setSeparator({ ...summary, pending })
  // Nodes may have come online or freed up: hand out queued songs.
  hub.emit('work-separate')
  if (!wasOnline && summary.online) hub.emit('work-mv')
}

const fetching = new Map<number, Promise<void>>()

/** Make sure a song's original audio is on disk (待机音乐: not queued, never separated). */
export function ensureOriginal(songId: number): Promise<void> {
  if (findOriginal(songId)) return Promise.resolve()
  const running = fetching.get(songId)
  if (running) return running
  const job = (async () => {
    const song = await getSong(songId)
    const audio = await resolveAudio(song)
    await download(audio.url, path.join(mediaDir(songId), `original.${audio.ext}`))
    enforceCacheLimit()
  })().finally(() => fetching.delete(songId))
  fetching.set(songId, job)
  return job
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
    separateLoop()
    void pollSeparator()
    void mvLoop()
  })
  hub.on('work-separate', () => separateLoop())
  hub.on('work-mv', () => void mvLoop())
  setTimeout(enforceCacheLimit, 10_000).unref()
  // Safety net: pick up MV work that was skipped while the separator was still starting.
  setInterval(() => hub.emit('work-mv'), 60_000).unref()
  void pollSeparator().then(() => hub.emit('work'))
  setInterval(() => void pollSeparator(), 5000).unref()
}
