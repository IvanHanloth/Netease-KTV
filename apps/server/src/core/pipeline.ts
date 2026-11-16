import fs from 'node:fs'
import { config } from '../config.js'
import { probeDuration } from '../media/ffmpeg.js'
import { busySong } from '../media/busy.js'
import { invalidateScan } from '../media/cache.js'
import {
  clearMedia,
  download,
  ensureMediaDir,
  findOriginal,
  hasPitch,
  hasStems,
  originalPath,
  pitchPath,
  stemPath,
  stemsAreOfficial,
} from '../media/files.js'
import { fetchOfficialStems } from '../media/official.js'
import { resolveAudio, UnavailableError } from '../media/resolve.js'
import { getCachedSong, getSong } from '../ncm/service.js'
import type { AudioSource, Song, StemSource } from '../shared/types.js'
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
import { forgetAlignment, startMvPreload } from './mvPreload.js'
import { enforceCacheLimit } from './storage.js'
import { singleFlight } from '../util.js'

/**
 * Prepares accompaniment for queued songs, in queue order:
 *   idle -> downloading -> queued -> separating -> ready
 * Downloads and separation run independently so the next song can download while the
 * separator nodes are busy; separations are spread over all nodes (see ../separator.ts).
 *
 * 伴奏来源 = official: a queued song first tries NetEase's own 随心唱 stems (../media/official.ts,
 * shown as separating with stemOrigin 'official'). Without them it goes back to queued for AI
 * separation, or plays the original when the AI fallback is off.
 */

const stemOrigin = (songId: number): StemSource => (stemsAreOfficial(songId) ? 'official' : 'ai')

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
    hub.setTrack(songId, { hasStems: true, hasPitch: hasPitch(songId), stemOrigin: stemOrigin(songId), message: undefined })
    return
  }
  if (track.status !== 'idle') return
  if (hasStems(songId)) {
    hub.setTrack(songId, { status: 'ready', progress: 1, hasStems: true, hasPitch: hasPitch(songId), stemOrigin: stemOrigin(songId) })
  }
  else if (findOriginal(songId)) hub.setTrack(songId, { status: 'queued', progress: 0, hasStems: false })
}

/**
 * Download a song's original audio into the cache (NetEase, or an unblock source when enabled),
 * rejecting unblock audio whose duration doesn't match the song (probably another version).
 */
async function fetchOriginal(song: Song, onProgress?: (p: number) => void): Promise<AudioSource> {
  const audio = await resolveAudio(song)
  ensureMediaDir(song.id)
  const dest = originalPath(song.id, audio.ext)
  await download(audio.url, dest, onProgress)
  invalidateScan()
  if (audio.source === 'unblock' && song.duration > 0) {
    const actual = await probeDuration(dest)
    if (actual > 0 && Math.abs(actual - song.duration) > config.unblockDurationTolerance) {
      fs.rmSync(dest, { force: true })
      throw new UnavailableError('no-source', '第三方音源与原曲时长不一致，可能是其他版本')
    }
  }
  return audio.source
}

async function downloadOne(songId: number): Promise<void> {
  hub.setTrack(songId, { status: 'downloading', progress: 0, message: undefined }, false)
  try {
    const song = await getSong(songId)
    const source = await busySong(songId, fetchOriginal(song, (p) => hub.setTrack(songId, { progress: p }, false)))
    // Removed from the queue while downloading: nothing waits for it, it goes back to idle
    // (the original stays cached and is picked up again if the song is requested).
    if (priorityIds().includes(songId)) hub.setTrack(songId, { status: 'queued', progress: 0, source, hasStems: false })
    else hub.setTrack(songId, { status: 'idle', progress: 0, message: undefined, source: undefined })
    void enforceCacheLimit()
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
  hub.setTrack(songId, { status: 'separating', progress: 0, stemOrigin: 'ai', message: undefined }, false)
  // No await before separateOnNode: it reserves the node slot synchronously, so the dispatcher's
  // next pick in the same pass already sees this node as busy.
  const song = getCachedSong(songId)
  // Busy until the pitch track has landed too (it may arrive after the song left the queue).
  let pitchDone: () => void = () => {}
  void busySong(songId, new Promise<void>((resolve) => (pitchDone = resolve)))
  ensureMediaDir(songId)
  try {
    const job = separateOnNode(node, {
      songId,
      songName: song?.name,
      input,
      durationMs: song?.duration ?? 0,
      model: getSettings().separatorModel,
      onProgress: (p) => hub.setTrack(songId, { status: 'separating', progress: p }, false),
    })
    job.then((r) => r.pitch.then(pitchDone, pitchDone), pitchDone)
    const { pitch } = await job
    invalidateScan()
    if (!hasStems(songId)) throw new Error('分离服务没有生成伴奏文件')
    attempts.delete(songId)
    // Playable now; the pitch track (for scoring) may still be computing.
    hub.setTrack(songId, {
      status: 'ready',
      progress: 1,
      hasStems: true,
      hasPitch: hasPitch(songId),
      stemOrigin: 'ai',
      message: undefined,
    })
    void enforceCacheLimit()
    pitchTried.add(songId)
    void pitch.then(() => {
      invalidateScan()
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
      stemOrigin: undefined,
      message: `伴奏生成失败，将播放原曲：${(err as Error).message}`,
    })
  }
}

/** Songs that already had their 随心唱 lookup this session (found, missing or failed). */
const officialTried = new Set<number>()
let officialBusy = false

function wantsOfficial(songId: number): boolean {
  return getSettings().stemSource === 'official' && !officialTried.has(songId) && hub.getTrack(songId).source !== 'unblock'
}

/** One song's 随心唱 stems (one at a time: they are ~20 MB downloads from NetEase). */
async function officialOne(songId: number): Promise<void> {
  officialTried.add(songId)
  officialBusy = true
  hub.setTrack(songId, { status: 'separating', progress: 0, stemOrigin: 'official', message: undefined }, false)
  let found = false
  let failure: string | undefined
  try {
    found = await busySong(
      songId,
      fetchOfficialStems(songId, (p) => hub.setTrack(songId, { progress: p }, false)),
    )
  } catch (err) {
    failure = (err as Error).message
    console.warn(`[pipeline] official stems for ${songId} failed:`, failure)
  } finally {
    officialBusy = false
  }
  invalidateScan()
  if (found && hasStems(songId)) {
    console.info(`[pipeline] ${songId}: 使用网易云随心唱伴奏`)
    attempts.delete(songId)
    hub.setTrack(songId, {
      status: 'ready',
      progress: 1,
      hasStems: true,
      hasPitch: hasPitch(songId),
      stemOrigin: 'official',
      message: undefined,
    })
    void enforceCacheLimit()
  } else if (getSettings().stemFallback) {
    hub.setTrack(songId, { status: 'queued', progress: 0, stemOrigin: undefined }, false)
  } else {
    hub.setTrack(songId, {
      status: 'ready',
      progress: 1,
      hasStems: false,
      stemOrigin: undefined,
      message: failure ? `获取官方伴奏失败，将播放原曲：${failure}` : '这首歌没有官方伴奏，将播放原曲',
    })
  }
  hub.emit('work-separate')
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
    if (await busySong(songId, pitchOnCluster(songId, stemPath(songId, 'vocals'), pitchPath(songId)))) {
      invalidateScan()
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
  releaseUnqueued()
  // Songs waiting for their 随心唱 lookup while another one is running are skipped this pass.
  const skip = new Set<number>()
  for (;;) {
    const id = priorityIds().find((x) => hub.getTrack(x).status === 'queued' && !skip.has(x))
    if (id === undefined) {
      const pid = !pitchBusy && clusterOnline() && !skip.size ? nextNeedingPitch() : undefined
      if (pid !== undefined) void pitchOne(pid)
      return
    }
    if (wantsOfficial(id)) {
      if (officialBusy) skip.add(id)
      else void officialOne(id)
      continue
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

/** Poll the separator servers now and hand out work (after an admin adds / edits / removes one). */
export function refreshSeparators(): Promise<void> {
  return pollSeparator()
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

const fetching = singleFlight<number, void>()

/**
 * Make sure a song's original audio is on disk: 待机音乐 (never queued, never separated), and
 * 原唱 for a song whose original was cleared from the cache while its stems were kept.
 */
export function ensureOriginal(songId: number): Promise<void> {
  if (findOriginal(songId)) return Promise.resolve()
  return fetching(songId, () =>
    busySong(
      songId,
      (async () => {
        await fetchOriginal(await getSong(songId))
        void enforceCacheLimit()
      })(),
    ),
  )
}

/** Forget what this session learned about a song's files (they were removed or are redone). */
function forgetSong(songId: number): void {
  pitchTried.delete(songId)
  officialTried.delete(songId)
  attempts.delete(songId)
  forgetAlignment(songId)
}

export function retry(songId: number): void {
  clearMedia(songId)
  invalidateScan()
  forgetSong(songId)
  hub.setTrack(songId, { status: 'idle', progress: 0, hasStems: false, hasPitch: false, message: undefined, source: undefined })
  hub.emit('work')
}

/**
 * Songs that left the queue while still waiting for a separator go back to idle, so they show as
 * not processed instead of 排队中 forever. Their original stays cached; reconcile() marks them
 * queued again if they are requested. Separations already running are left to finish.
 */
function releaseUnqueued(): void {
  const wanted = new Set(priorityIds())
  for (const t of [...hub.tracks.values()]) {
    if (t.status === 'queued' && !wanted.has(t.songId)) {
      attempts.delete(t.songId)
      hub.setTrack(t.songId, { status: 'idle', progress: 0, message: undefined, source: undefined })
    }
  }
}

/**
 * A song coming back into the queue gets another chance: an earlier failure (no source, download
 * error, separation that fell back to the original) is retried instead of remembered forever.
 * Songs already queued or playing are left alone.
 */
export function giveAnotherChance(songId: number): void {
  if (priorityIds().includes(songId)) return
  const t = hub.getTrack(songId)
  if (t.status === 'unavailable' || t.status === 'error') {
    hub.setTrack(songId, { status: 'idle', progress: 0, message: undefined })
  } else if (t.status === 'ready' && !t.hasStems && t.message) {
    forgetSong(songId)
    hub.setTrack(songId, { status: findOriginal(songId) ? 'queued' : 'idle', progress: 0, message: undefined })
  }
}

export function startPipeline(): void {
  // Files were cleared from the cache: what this session remembered about them is void.
  hub.on('media-removed', ({ songIds }: { songIds: number[]; mvIds: number[] }) => {
    for (const id of songIds) forgetSong(id)
    if (songIds.length) hub.emit('work')
  })
  hub.on('work', () => {
    void downloadLoop()
    separateLoop()
    void pollSeparator()
  })
  hub.on('work-separate', () => separateLoop())
  startMvPreload()
  setTimeout(() => void enforceCacheLimit(), 10_000).unref()
  void pollSeparator().then(() => hub.emit('work'))
  setInterval(() => void pollSeparator(), 5000).unref()
}
