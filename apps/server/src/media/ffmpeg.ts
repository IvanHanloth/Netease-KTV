import { spawn } from 'node:child_process'
import fs from 'node:fs'
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

const inflight = new Map<string, Promise<void>>()

/**
 * Render a pitch-shifted copy (semitones) of `input` into `output` (FLAC).
 * Uses ffmpeg's rubberband filter when available, otherwise asetrate + atempo.
 */
export function renderPitch(input: string, output: string, semitones: number): Promise<void> {
  const existing = inflight.get(output)
  if (existing) return existing
  const job = (async () => {
    const ratio = Math.pow(2, semitones / 12)
    const filter = (await hasRubberband())
      ? `rubberband=pitch=${ratio.toFixed(6)}:pitchq=quality`
      : `asetrate=44100*${ratio.toFixed(6)},aresample=44100,atempo=${(1 / ratio).toFixed(6)}`
    const tmp = `${output}.part.flac`
    const { code, stderr } = await run(config.ffmpeg, [
      '-y', '-v', 'error', '-i', input, '-vn', '-af', filter, '-ar', '44100', '-c:a', 'flac', tmp,
    ])
    if (code !== 0) throw new Error(`ffmpeg pitch failed: ${stderr.slice(-400)}`)
    fs.renameSync(tmp, output)
  })().finally(() => inflight.delete(output))
  inflight.set(output, job)
  return job
}

const queued = new Set<string>()
const background: (() => Promise<void>)[] = []
let backgroundRunning = 0

/**
 * Render a pitch-shifted copy in the background (at most 2 at a time), unless it already exists or
 * is being rendered. Used to have the neighbouring keys ready before the singer asks for them:
 * a full stem takes ~7 s, which made every +/- press feel broken.
 */
export function renderPitchLater(input: string, output: string, semitones: number): void {
  if (queued.has(output) || inflight.has(output) || fs.existsSync(output)) return
  queued.add(output)
  background.push(() => renderPitch(input, output, semitones).catch(() => {}).finally(() => queued.delete(output)))
  pumpBackground()
}

function pumpBackground(): void {
  while (backgroundRunning < 2 && background.length) {
    const job = background.shift()!
    backgroundRunning++
    void job().finally(() => {
      backgroundRunning--
      pumpBackground()
    })
  }
}

export async function ffmpegAvailable(): Promise<boolean> {
  try {
    const { code } = await run(config.ffmpeg, ['-version'])
    return code === 0
  } catch {
    return false
  }
}
