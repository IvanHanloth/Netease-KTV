import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
/** Repo root when running from source or from dist. */
const repoRoot = path.resolve(here, '../../..')

function bool(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined || v === '') return fallback
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())
}

function list(v: string | undefined, fallback: string[]): string[] {
  if (!v) return fallback
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

export const config = {
  port: Number(process.env.PORT ?? 8686),
  host: process.env.HOST ?? '0.0.0.0',
  dataDir: path.resolve(process.env.DATA_DIR ?? path.join(repoRoot, 'data')),
  webDist: path.resolve(process.env.WEB_DIST ?? path.join(repoRoot, 'apps/web/dist')),
  /** Optional LAN access token. Empty = no auth. */
  accessToken: process.env.ACCESS_TOKEN ?? '',
  /** Local separator node added on first start ('' with KTV_SEPARATOR=off: separation only on other machines). */
  separatorUrl:
    process.env.KTV_SEPARATOR === 'off' ? '' : (process.env.SEPARATOR_URL ?? 'http://127.0.0.1:9000').replace(/\/$/, ''),
  ffmpeg: process.env.FFMPEG_PATH ?? 'ffmpeg',
  ffprobe: process.env.FFPROBE_PATH ?? 'ffprobe',
  /** Defaults for settings that can be changed in the UI. */
  defaults: {
    unblockEnabled: bool(process.env.ENABLE_UNBLOCK, false),
    unblockSources: list(process.env.UNBLOCK_SOURCES, ['unm']),
    audioLevel: (process.env.AUDIO_LEVEL ?? 'exhigh') as 'exhigh',
    separatorModel: process.env.SEPARATOR_MODEL ?? '',
    publicUrl: process.env.PUBLIC_URL ?? '',
    scoringEnabled: bool(process.env.SCORING_ENABLED, true),
    scoreTolerance: Number(process.env.SCORE_TOLERANCE ?? 1) || 1,
    mvPreload: bool(process.env.MV_PRELOAD, true),
    mvResolution: ([480, 720, 1080].includes(Number(process.env.MV_RESOLUTION)) ? Number(process.env.MV_RESOLUTION) : 720) as 480 | 720 | 1080,
    cacheLimitGB: Number(process.env.CACHE_LIMIT_GB ?? 20) || 20,
    multiScreenSync: false,
    multiScreenAudio: false,
    idleEnabled: bool(process.env.IDLE_MUSIC, true),
    idleVolume: 0.5,
    // Tony Anderson – 1993
    idleSongs: [2755842309],
  },
  /** Allowed difference between NetEase duration and unblock audio duration. */
  unblockDurationTolerance: Number(process.env.UNBLOCK_DURATION_TOLERANCE ?? 3000),
  version: '0.1.2',
}

export const paths = {
  db: () => path.join(config.dataDir, 'ktv.db'),
  media: (songId: number) => path.join(config.dataDir, 'media', String(songId)),
  mediaRoot: () => path.join(config.dataDir, 'media'),
  mvRoot: () => path.join(config.dataDir, 'mv'),
  tmp: () => path.join(config.dataDir, 'tmp'),
}
