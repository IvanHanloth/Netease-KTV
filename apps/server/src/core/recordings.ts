import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { paths } from '../config.js'
import { ffmpegJob, probeDuration, renderPitch } from '../media/ffmpeg.js'
import { findOriginal, pitchedPath, stemFile, BROWSER_UA } from '../media/files.js'
import { buildAss, hasTimedLyrics } from '../media/lyricsAss.js'
import { cachedMv, ensureMv, readAlignment } from '../media/mv.js'
import * as ncm from '../ncm/service.js'
import { getSettings } from '../settings.js'
import { singerName } from '../shared/constants.js'
import type {
  RecordingCreate,
  RecordingInfo,
  RecordingOffer,
  RecordingRender,
  RecordingRenderKind,
  RecordingTake,
  Song,
} from '../shared/types.js'
import { hub } from './hub.js'
import { ensureOriginal } from './pipeline.js'

/**
 * 录制: the 主屏 records the microphone during a song and uploads it when the song ends. The
 * 大屏 then shows a QR code for `recordQrSeconds`. Nobody opens the link in time: the recording is
 * deleted. Someone does: it is kept for `recordKeepHours`, and from that page they can have it
 * mixed with the accompaniment (audio), put under the MV, or made into a lyrics video.
 *
 *   recordings/<id>/meta.json        what the 主屏 sent + state
 *   recordings/<id>/take_<n>.<ext>   microphone takes (MediaRecorder output)
 *   recordings/<id>/mix.m4a          伴奏 + voice
 *   recordings/<id>/mv.mp4, lyrics.mp4
 */

interface Meta extends RecordingCreate {
  id: string
  song: Song
  createdAt: number
  /** Takes received so far (by index). */
  received: boolean[]
  /** All takes are in: the QR code went up at this time. */
  finishedAt?: number
  offerExpiresAt?: number
  claimedAt?: number
  renders: Partial<Record<RecordingRenderKind, Omit<RecordingRender, 'url' | 'size' | 'progress'>>>
}

const KINDS: RecordingRenderKind[] = ['audio', 'mv', 'lyrics']
const FILES: Record<RecordingRenderKind, string> = { audio: 'mix.m4a', mv: 'mv.mp4', lyrics: 'lyrics.mp4' }
/** A take: at most this big (an hour of opus is ~60 MB). */
export const MAX_TAKE_BYTES = 200 * 1024 * 1024
/** Uploads that never finish are dropped after this long. */
const UNFINISHED_MS = 10 * 60_000
/** Someone scanning right as the countdown ends still gets in. */
const GRACE_MS = 15_000

const dirOf = (id: string) => path.join(paths.recordings(), id)
const metaFile = (id: string) => path.join(dirOf(id), 'meta.json')
const validId = (id: string) => /^[A-Za-z0-9_-]{8,32}$/.test(id)

function readMeta(id: string): Meta | null {
  if (!validId(id)) return null
  try {
    return JSON.parse(fs.readFileSync(metaFile(id), 'utf8')) as Meta
  } catch {
    return null
  }
}

function writeMeta(m: Meta): void {
  const tmp = metaFile(m.id) + '.part'
  fs.writeFileSync(tmp, JSON.stringify(m))
  fs.renameSync(tmp, metaFile(m.id))
}

function remove(id: string): void {
  fs.rmSync(dirOf(id), { recursive: true, force: true })
  progress.delete(id)
  if (offer?.id === id) setOffer(null)
}

function takeExt(mime: string): string {
  if (/mp4|aac|m4a/i.test(mime)) return 'm4a'
  if (/ogg/i.test(mime)) return 'ogg'
  return 'webm'
}
const takeFile = (m: Meta, n: number) => path.join(dirOf(m.id), `take_${n}.${takeExt(m.takes[n]!.mime)}`)

// ---------- the QR code offer ----------

let offer: RecordingOffer | null = null

export function currentOffer(): RecordingOffer | null {
  return offer
}

function setOffer(next: RecordingOffer | null): void {
  offer = next
  hub.broadcast({ type: 'recording', offer })
}

const artistsOf = (s: Song) => s.artists.map((a) => a.name).join(' / ')

// ---------- upload (from the 主屏) ----------

export class RecordingError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message)
  }
}

export async function createRecording(body: RecordingCreate): Promise<{ id: string }> {
  if (!getSettings().recordEnabled) throw new RecordingError('录制没有开启', 409)
  if (!body.takes.length) throw new RecordingError('没有录到声音')
  const song = await ncm.getSong(body.songId)
  const id = crypto.randomBytes(9).toString('base64url')
  fs.mkdirSync(dirOf(id), { recursive: true })
  writeMeta({ ...body, id, song, createdAt: Date.now(), received: body.takes.map(() => false), renders: {} })
  const secs = body.takes.reduce((s, t) => s + t.segments.reduce((a, x) => a + x.dur, 0), 0) / 1000
  console.info(`[录制] ${id} 收到《${song.name}》 ${body.takes.length} 段，共 ${Math.round(secs)} 秒`)
  return { id }
}

export function saveTake(id: string, n: number, data: Buffer): void {
  const m = readMeta(id)
  if (!m || m.finishedAt) throw new RecordingError('录音不存在', 404)
  if (!Number.isInteger(n) || n < 0 || n >= m.takes.length) throw new RecordingError('录音片段编号不对')
  if (!data.length) throw new RecordingError('录音是空的')
  const file = takeFile(m, n)
  fs.writeFileSync(file + '.part', data)
  fs.renameSync(file + '.part', file)
  m.received[n] = true
  writeMeta(m)
}

/** Every take is in: show the QR code. */
export function finishRecording(id: string): RecordingOffer {
  const m = readMeta(id)
  if (!m) throw new RecordingError('录音不存在', 404)
  if (m.received.some((r) => !r)) throw new RecordingError('还有录音片段没有上传')
  const now = Date.now()
  m.finishedAt = now
  m.offerExpiresAt = now + getSettings().recordQrSeconds * 1000
  writeMeta(m)
  const o: RecordingOffer = {
    id,
    songName: m.song.name,
    artists: artistsOf(m.song),
    singer: singerName(m.singer),
    expiresAt: m.offerExpiresAt,
    claimed: false,
  }
  setOffer(o)
  console.info(`[录制] ${id} 上传完成，二维码显示 ${getSettings().recordQrSeconds} 秒`)
  return o
}

// ---------- the phone page ----------

function expiresAt(m: Meta): number {
  if (m.claimedAt) return m.claimedAt + getSettings().recordKeepHours * 3_600_000
  if (m.offerExpiresAt) return m.offerExpiresAt + GRACE_MS
  return m.createdAt + UNFINISHED_MS
}

/** A recording people may see: uploaded, and either claimed or still on the QR countdown. */
function openMeta(id: string): Meta {
  const m = readMeta(id)
  if (!m || !m.finishedAt || Date.now() > expiresAt(m)) throw new RecordingError('录音已过期或不存在', 404)
  return m
}

/** Opening the link keeps the recording (and starts mixing the audio right away). */
export function claimRecording(id: string): void {
  const m = openMeta(id)
  if (m.claimedAt) return
  m.claimedAt = Date.now()
  writeMeta(m)
  console.info(`[录制] ${id} 已扫码`)
  if (offer?.id === id && !offer.claimed) setOffer({ ...offer, claimed: true })
  enqueue(id, 'audio')
}

export async function recordingInfo(id: string): Promise<RecordingInfo> {
  const m = openMeta(id)
  const song = m.song
  const lyrics = await ncm.lyrics(song.id).catch(() => null)
  const renders = {} as Record<RecordingRenderKind, RecordingRender>
  for (const k of KINDS) {
    const r = m.renders[k]
    const file = path.join(dirOf(id), FILES[k])
    const ready = r?.status === 'ready' && fs.existsSync(file)
    renders[k] = {
      status: ready ? 'ready' : r?.status === 'ready' ? 'idle' : (r?.status ?? 'idle'),
      progress: ready ? 1 : (progress.get(id)?.[k] ?? 0),
      ...(r?.error ? { error: r.error } : {}),
      ...(ready ? { url: `/api/recordings/${id}/files/${k}`, size: fs.statSync(file).size } : {}),
    }
  }
  return {
    id,
    song,
    singer: singerName(m.singer),
    createdAt: m.createdAt,
    expiresAt: expiresAt(m),
    expiresIn: Math.max(0, expiresAt(m) - Date.now()),
    claimed: !!m.claimedAt,
    hasMv: song.mvId > 0 && (!!cachedMv(song.mvId) || !ncm.mvUnavailable(song.mvId)),
    hasLyrics: hasTimedLyrics(lyrics),
    renders,
  }
}

export function requestRender(id: string, kind: RecordingRenderKind): void {
  const m = openMeta(id)
  if (!m.claimedAt) throw new RecordingError('请先打开录音页面', 409)
  const st = m.renders[kind]?.status
  if (st === 'queued' || st === 'running') return
  if (st === 'ready' && fs.existsSync(path.join(dirOf(id), FILES[kind]))) return
  enqueue(id, kind)
}

/** A finished render for download, with the name it should be saved under. */
export function renderFile(id: string, kind: RecordingRenderKind): { file: string; name: string } {
  const m = openMeta(id)
  const file = path.join(dirOf(id), FILES[kind])
  if (m.renders[kind]?.status !== 'ready' || !fs.existsSync(file)) throw new RecordingError('还没有合成好', 404)
  const who = singerName(m.singer) ?? artistsOf(m.song)
  const label = kind === 'audio' ? '' : kind === 'mv' ? ' (MV)' : ' (歌词视频)'
  const name = `${m.song.name} - ${who}${label}${path.extname(file)}`.replace(/[\\/:*?"<>|]/g, '_')
  return { file, name }
}

// ---------- renders ----------

/** Progress of running renders, by recording (kept in memory: it changes several times a second). */
const progress = new Map<string, Partial<Record<RecordingRenderKind, number>>>()
const queue: { id: string; kind: RecordingRenderKind }[] = []
let working = false

function setRender(id: string, kind: RecordingRenderKind, r: Meta['renders'][RecordingRenderKind]): Meta | null {
  const m = readMeta(id)
  if (!m) return null
  m.renders[kind] = r
  writeMeta(m)
  return m
}

function enqueue(id: string, kind: RecordingRenderKind): void {
  if (queue.some((j) => j.id === id && j.kind === kind)) return
  setRender(id, kind, { status: 'queued' })
  queue.push({ id, kind })
  void work()
}

async function work(): Promise<void> {
  if (working) return
  working = true
  try {
    for (let job = queue.shift(); job; job = queue.shift()) {
      const { id, kind } = job
      if (!readMeta(id)) continue
      setRender(id, kind, { status: 'running' })
      const report = (p: number) => progress.set(id, { ...progress.get(id), [kind]: p })
      report(0)
      try {
        await render(id, kind, report)
        setRender(id, kind, { status: 'ready' })
      } catch (e) {
        console.warn(`[ktv] recording ${id} ${kind} failed:`, e)
        if (readMeta(id)) setRender(id, kind, { status: 'error', error: e instanceof Error ? e.message.slice(0, 300) : '合成失败' })
      }
      const p = progress.get(id)
      if (p) delete p[kind]
    }
  } finally {
    working = false
  }
}

async function render(id: string, kind: RecordingRenderKind, report: (p: number) => void): Promise<void> {
  const m = readMeta(id)
  if (!m) throw new Error('录音不存在')
  const dir = dirOf(id)
  const mix = path.join(dir, FILES.audio)
  // The videos are built on the mix: make it first (it takes a few seconds).
  if (kind !== 'audio' && !(m.renders.audio?.status === 'ready' && fs.existsSync(mix))) {
    setRender(id, 'audio', { status: 'running' })
    try {
      await renderMix(m, () => {})
    } catch (e) {
      setRender(id, 'audio', { status: 'error', error: e instanceof Error ? e.message.slice(0, 300) : '合成失败' })
      throw e
    }
    setRender(id, 'audio', { status: 'ready' })
  }
  if (kind === 'audio') return renderMix(m, report)
  if (kind === 'mv') return renderMv(m, report)
  return renderLyricsVideo(m, report)
}

/** The accompaniment the song was sung to: 伴奏 (or the original without stems) at the sung key. */
async function accompaniment(m: Meta): Promise<string> {
  const songId = m.song.id
  let file = stemFile(songId, 'instrumental')
  const stem = file ? 'instrumental' : 'original'
  if (!file) {
    file = findOriginal(songId)
    if (!file) {
      await ensureOriginal(songId)
      file = findOriginal(songId)
    }
  }
  if (!file) throw new Error('找不到这首歌的伴奏')
  if (!m.key) return file
  const pitched = pitchedPath(songId, stem, m.key)
  if (!fs.existsSync(pitched)) await renderPitch(file, pitched, m.key)
  return pitched
}

/** Microphone level as the room heard it, relative to the song (micMixer's level curve). */
function voiceGain(m: Meta): number {
  const mic = 2 * m.micVolume * m.micVolume
  return Math.min(6, Math.max(0.3, mic / Math.max(0.05, m.musicVolume)))
}

async function renderMix(m: Meta, report: (p: number) => void): Promise<void> {
  const acc = await accompaniment(m)
  const dir = dirOf(m.id)
  const inputs = ['-i', acc]
  const parts: string[] = ['[0:a]aresample=48000,aformat=channel_layouts=stereo[acc]']
  const voices: string[] = []
  m.takes.forEach((take: RecordingTake, i) => {
    const segs = take.segments.filter((s) => s.dur > 200)
    if (!segs.length) return
    inputs.push('-i', takeFile(m, i))
    const n = inputs.length / 2 - 1
    const src = `[${n}:a]aresample=48000,aformat=channel_layouts=stereo,asetpts=N/SR/TB`
    const labels = segs.map((_, j) => `t${i}s${j}`)
    parts.push(labels.length > 1 ? `${src},asplit=${labels.length}${labels.map((l) => `[${l}]`).join('')}` : `${src}[${labels[0]}]`)
    segs.forEach((s, j) => {
      // What was sung `latencyMs` after a moment belongs to the song position heard at that moment.
      const start = Math.max(0, (s.rec + m.latencyMs) / 1000)
      const delay = Math.max(0, Math.round(s.pos * 1000))
      const out = `v${i}s${j}`
      parts.push(`[${labels[j]}]atrim=start=${start.toFixed(3)}:duration=${(s.dur / 1000).toFixed(3)},asetpts=PTS-STARTPTS,adelay=${delay}:all=1[${out}]`)
      voices.push(`[${out}]`)
    })
  })
  if (!voices.length) throw new Error('录音里没有可用的人声')
  parts.push(
    voices.length > 1 ? `${voices.join('')}amix=inputs=${voices.length}:normalize=0:dropout_transition=0[voc]` : `${voices[0]}anull[voc]`,
    `[voc]volume=${voiceGain(m).toFixed(3)}[vocg]`,
    // Even loudness, then a hard ceiling (alimiter would otherwise level its output up to 0 dB).
    // loudnorm works at 192 kHz internally: back to 48 kHz stereo for the encoder (older ffmpeg
    // builds can't negotiate the layout on their own after it).
    '[acc][vocg]amix=inputs=2:normalize=0:duration=first:dropout_transition=0,loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,alimiter=limit=0.84:level=0[out]',
  )
  const duration = (await probeDuration(acc)) / 1000 || m.song.duration / 1000
  const tmp = path.join(dir, 'mix.part.m4a')
  await ffmpegJob([...inputs, '-filter_complex', parts.join(';'), '-map', '[out]', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', tmp], {
    duration,
    onProgress: report,
  })
  fs.renameSync(tmp, path.join(dir, FILES.audio))
}

async function writeAss(m: Meta, durationMs: number): Promise<string | null> {
  const lyrics = await ncm.lyrics(m.song.id).catch(() => null)
  if (!hasTimedLyrics(lyrics)) return null
  const who = singerName(m.singer)
  const name = 'lyrics.ass'
  const ass = buildAss(lyrics, {
    durationMs,
    title: m.song.name,
    subtitle: who ? `${artistsOf(m.song)} · 演唱：${who}` : artistsOf(m.song),
  })
  fs.writeFileSync(path.join(dirOf(m.id), name), ass)
  return name
}

/** The subtitles filter for a file in the job's directory (run with that cwd; the font is in its styles). */
const subtitles = (name: string) => `subtitles=${name}`

async function renderMv(m: Meta, report: (p: number) => void): Promise<void> {
  if (!m.song.mvId) throw new Error('这首歌没有 MV')
  const dir = dirOf(m.id)
  const mv = cachedMv(m.song.mvId) ?? (await ensureMv(m.song.mvId))
  const mix = path.join(dir, FILES.audio)
  const duration = (await probeDuration(mix)) / 1000 || m.song.duration / 1000
  // videoTime = audioTime + offset: a positive offset skips the MV's intro, a negative one waits.
  const offset = readAlignment(m.song.id, m.song.mvId)?.offset ?? 0
  // No lyrics on top: most MVs have their own burnt in (the lyrics video is the one with ours).
  const chain = [
    'scale=1280:720:force_original_aspect_ratio=decrease',
    'pad=1280:720:(ow-iw)/2:(oh-ih)/2',
    'setsar=1',
    'fps=30',
    ...(offset < 0 ? [`tpad=start_duration=${(-offset).toFixed(3)}:start_mode=clone`] : []),
    'tpad=stop=-1:stop_mode=clone',
    'format=yuv420p',
  ]
  const tmp = 'mv.part.mp4'
  await ffmpegJob(
    [
      ...(offset > 0 ? ['-ss', offset.toFixed(3)] : []),
      '-i', mv,
      '-i', mix,
      '-filter_complex', `[0:v]${chain.join(',')}[v]`,
      '-map', '[v]', '-map', '1:a',
      '-t', duration.toFixed(3),
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
      '-c:a', 'copy', '-movflags', '+faststart', tmp,
    ],
    { cwd: dir, duration, onProgress: report },
  )
  fs.renameSync(path.join(dir, tmp), path.join(dir, FILES.mv))
}

/** The album cover, for the lyrics video's background (null: a plain dark one). */
async function cover(m: Meta): Promise<string | null> {
  const url = m.song.album.picUrl
  if (!url) return null
  const file = path.join(dirOf(m.id), 'cover.jpg')
  if (fs.existsSync(file)) return file
  try {
    const u = new URL(url)
    u.protocol = 'https:'
    u.searchParams.set('param', '800y800')
    const res = await fetch(u, { headers: { 'User-Agent': BROWSER_UA }, signal: AbortSignal.timeout(15_000) })
    if (!res.ok) return null
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()))
    return file
  } catch {
    return null
  }
}

async function renderLyricsVideo(m: Meta, report: (p: number) => void): Promise<void> {
  const dir = dirOf(m.id)
  const mix = path.join(dir, FILES.audio)
  const duration = (await probeDuration(mix)) / 1000 || m.song.duration / 1000
  const ass = await writeAss(m, duration * 1000)
  if (!ass) throw new Error('这首歌没有歌词')
  // The background once, as a picture: the blurred cover (blurring every frame would be slow).
  const art = await cover(m)
  if (art) {
    await ffmpegJob(
      ['-i', art, '-vf', 'scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,gblur=sigma=36,eq=brightness=-0.3:saturation=1.15', '-frames:v', '1', 'bg.png'],
      { cwd: dir },
    )
  }
  const tmp = 'lyrics.part.mp4'
  await ffmpegJob(
    [
      ...(art ? ['-loop', '1', '-framerate', '25', '-i', 'bg.png'] : ['-f', 'lavfi', '-i', 'color=c=0x16161E:s=1280x720:r=25']),
      '-i', mix,
      '-filter_complex', `[0:v]${subtitles(ass)},format=yuv420p[v]`,
      '-map', '[v]', '-map', '1:a',
      '-t', duration.toFixed(3),
      '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'stillimage', '-crf', '24', '-r', '25',
      '-c:a', 'copy', '-movflags', '+faststart', tmp,
    ],
    { cwd: dir, duration, onProgress: report },
  )
  fs.renameSync(path.join(dir, tmp), path.join(dir, FILES.lyrics))
}

// ---------- housekeeping ----------

/** Delete what has expired; end the QR countdown. Runs every few seconds. */
function sweep(): void {
  const now = Date.now()
  if (offer && now > offer.expiresAt) setOffer(null)
  let ids: string[]
  try {
    ids = fs.readdirSync(paths.recordings())
  } catch {
    return
  }
  for (const id of ids) {
    const m = readMeta(id)
    if (!m) {
      // A directory without a readable meta.json (a crash mid-create): give it an hour.
      try {
        if (now - fs.statSync(dirOf(id)).mtimeMs > 3_600_000) fs.rmSync(dirOf(id), { recursive: true, force: true })
      } catch {
        /* gone already */
      }
      continue
    }
    const busy = queue.some((j) => j.id === id) || Object.values(m.renders).some((r) => r?.status === 'running')
    if (now > expiresAt(m) && !busy) {
      console.info(`[录制] ${id} ${m.claimedAt ? '保留期已到' : m.finishedAt ? '无人扫码' : '上传未完成'}，已删除`)
      remove(id)
    }
  }
}

export function startRecordings(): void {
  fs.mkdirSync(paths.recordings(), { recursive: true })
  // Renders that were running when the server stopped start over when asked again.
  for (const id of fs.readdirSync(paths.recordings())) {
    const m = readMeta(id)
    if (!m) continue
    let changed = false
    for (const k of KINDS) {
      const st = m.renders[k]?.status
      if (st === 'running' || st === 'queued') {
        m.renders[k] = { status: 'idle' }
        changed = true
      }
    }
    if (changed) writeMeta(m)
  }
  sweep()
  setInterval(sweep, 5_000).unref()
}
