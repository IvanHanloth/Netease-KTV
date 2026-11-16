import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { config } from '../config.js'

function run(cmd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('error', reject)
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }))
  })
}

/** Duration of a media file in ms, or 0 when ffprobe fails. */
export async function probeDuration(file: string): Promise<number> {
  try {
    const { code, stdout } = await run(config.ffprobe, [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file,
    ])
    if (code !== 0) return 0
    return Math.round(Number(stdout.trim()) * 1000) || 0
  } catch {
    return 0
  }
}

/** Channel count of the first audio stream, or 0 when ffprobe fails. */
export async function probeChannels(file: string): Promise<number> {
  try {
    const { code, stdout } = await run(config.ffprobe, [
      '-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=channels', '-of', 'default=nw=1:nk=1', file,
    ])
    return code === 0 ? Number(stdout.trim()) || 0 : 0
  } catch {
    return 0
  }
}

let rubberband: boolean | null = null

async function hasRubberband(): Promise<boolean> {
  if (rubberband !== null) return rubberband
  try {
    const { stdout } = await run(config.ffmpeg, ['-hide_banner', '-filters'])
    rubberband = /\brubberband\b/.test(stdout)
  } catch {
    rubberband = false
  }
  return rubberband
}

async function encodePitch(input: string, output: string, semitones: number): Promise<void> {
  const ratio = Math.pow(2, semitones / 12)
  const filter = (await hasRubberband())
    ? `rubberband=pitch=${ratio.toFixed(6)}:pitchq=quality`
    : `asetrate=44100*${ratio.toFixed(6)},aresample=44100,atempo=${(1 / ratio).toFixed(6)}`
  fs.mkdirSync(path.dirname(output), { recursive: true })
  const tmp = `${output}.part.flac`
  try {
    const { code, stderr } = await run(config.ffmpeg, [
      '-y', '-v', 'error', '-i', input, '-vn', '-af', filter, '-ar', '44100', '-c:a', 'flac', tmp,
    ])
    if (code !== 0) throw new Error(`ffmpeg pitch failed: ${stderr.slice(-400)}`)
    fs.renameSync(tmp, output)
  } catch (err) {
    fs.rmSync(tmp, { force: true })
    throw err
  }
}

interface RenderJob {
  /** Someone is waiting for this file right now (a key change). */
  foreground: boolean
  started: boolean
  wanted?: () => boolean
  start: () => void
  promise: Promise<void>
}

/** Background renders at once; they only run while no foreground render is running. */
const MAX_BACKGROUND = 1
/** Background renders waiting; the oldest are dropped beyond this. */
const MAX_BACKLOG = 12

let foregroundRunning = 0
let backgroundRunning = 0
const inflight = new Map<string, RenderJob>()
/** Background jobs not started yet, oldest first (the newest is started first). */
const backlog: RenderJob[] = []

function pump(): void {
  while (foregroundRunning === 0 && backgroundRunning < MAX_BACKGROUND && backlog.length) backlog.pop()!.start()
}

/**
 * Render a pitch-shifted copy (semitones) of `input` into `output` (FLAC), with ffmpeg's
 * rubberband filter when available (otherwise asetrate + atempo).
 *
 * A render someone waits for starts at once. Background renders (neighbouring keys) run one at a
 * time, newest first, only while nothing is rendered in the foreground, and are skipped when
 * `wanted()` says no by the time their turn comes. A foreground request for a file that is still
 * waiting in the background starts it immediately.
 */
export function renderPitch(
  input: string,
  output: string,
  semitones: number,
  opts: { background?: boolean; wanted?: () => boolean } = {},
): Promise<void> {
  const existing = inflight.get(output)
  if (existing) {
    if (!opts.background && !existing.started) {
      const i = backlog.indexOf(existing)
      if (i >= 0) backlog.splice(i, 1)
      existing.foreground = true
      existing.start()
    }
    return existing.promise
  }
  const job = { foreground: !opts.background, started: false, wanted: opts.wanted } as RenderJob
  job.promise = new Promise<void>((resolve, reject) => {
    job.start = () => {
      if (job.started) return
      job.started = true
      const fg = job.foreground
      if (fg) foregroundRunning++
      else backgroundRunning++
      ;(async () => {
        if (!fg && job.wanted && !job.wanted()) return
        if (fs.existsSync(output)) return
        await encodePitch(input, output, semitones)
      })()
        .then(resolve, reject)
        .finally(() => {
          if (fg) foregroundRunning--
          else backgroundRunning--
          inflight.delete(output)
          pump()
        })
    }
  })
  inflight.set(output, job)
  if (job.foreground) job.start()
  else {
    backlog.push(job)
    while (backlog.length > MAX_BACKLOG) {
      const dropped = backlog.shift()!
      dropped.wanted = () => false
      dropped.start()
    }
    pump()
  }
  return job.promise
}

/**
 * Render a pitch-shifted copy in the background, unless it already exists or is on its way.
 * Used to have the neighbouring keys ready before the singer asks for them: a full stem takes
 * ~7 s, which made every +/- press feel broken.
 */
export function renderPitchLater(input: string, output: string, semitones: number, wanted?: () => boolean): void {
  if (inflight.has(output) || fs.existsSync(output)) return
  void renderPitch(input, output, semitones, { background: true, wanted }).catch(() => {})
}

/** 11.025 kHz mono WAV of the first 15 minutes: plenty for MV ↔ song onset / chroma matching. */
export async function extractAnalysisWav(input: string, output: string): Promise<void> {
  const { code, stderr } = await run(config.ffmpeg, ['-y', '-v', 'error', '-i', input, '-vn', '-ac', '1', '-ar', '11025', '-t', '900', output])
  if (code !== 0) throw new Error(`ffmpeg: ${stderr.slice(-300)}`)
}

/**
 * Run a longer ffmpeg job (a 录制 render) with progress: `onProgress` gets 0..1 of `duration`
 * seconds of output. `cwd` lets filters refer to files by bare name (paths with a drive letter
 * break the subtitles filter's option syntax on Windows).
 */
export function ffmpegJob(
  args: string[],
  opts: { cwd?: string; duration?: number; onProgress?: (p: number) => void } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(config.ffmpeg, ['-y', '-v', 'error', '-nostats', '-progress', 'pipe:1', ...args], {
      windowsHide: true,
      cwd: opts.cwd,
    })
    let stderr = ''
    let buf = ''
    child.stdout.on('data', (d: Buffer) => {
      buf += d.toString()
      let i: number
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        const m = /^out_time_us=(\d+)/.exec(line)
        if (m && opts.duration && opts.onProgress) opts.onProgress(Math.min(1, Number(m[1]) / 1e6 / opts.duration))
      }
    })
    child.stderr.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-2000)
    })
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg 失败：${stderr.trim().slice(-400)}`))))
  })
}

export async function ffmpegAvailable(): Promise<boolean> {
  try {
    const { code } = await run(config.ffmpeg, ['-version'])
    return code === 0
  } catch {
    return false
  }
}
