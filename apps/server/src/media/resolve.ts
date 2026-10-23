import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { call } from '../ncm/client.js'
import { isPaidFee } from '../ncm/mappers.js'
import { getSettings } from '../settings.js'
import type { AudioSource, Song } from '../shared/types.js'

const require = createRequire(import.meta.url)

export class UnavailableError extends Error {
  constructor(
    public reason: 'vip' | 'no-source',
    message: string,
  ) {
    super(message)
  }
}

export interface ResolvedAudio {
  url: string
  source: AudioSource
  ext: string
}

// ---------- unblock (opt-in, only for songs NetEase has no source for) ----------

function unblockPackageDir(): string | null {
  try {
    const apiDir = path.dirname(require.resolve('@neteasecloudmusicapienhanced/api/package.json'))
    const pkg = require.resolve('@neteasecloudmusicapienhanced/unblockmusic-utils/package.json', { paths: [apiDir] })
    return path.dirname(pkg)
  } catch {
    return null
  }
}

/** Source module names shipped with unblockmusic-utils (e.g. unm, gdmusic, ...). */
let unblockSources: string[] | null = null

/** Third-party source modules shipped with the unblock package (read once: they don't change). */
export function listUnblockSources(): string[] {
  unblockSources ??= readUnblockSources()
  return unblockSources
}

function readUnblockSources(): string[] {
  const dir = unblockPackageDir()
  if (!dir) return []
  try {
    return fs
      .readdirSync(path.join(dir, 'modules'))
      .filter((f) => f.endsWith('.js'))
      .map((f) => f.replace(/\.js$/, ''))
      .sort((a, b) => (a === 'unm' ? -1 : b === 'unm' ? 1 : a.localeCompare(b)))
  } catch {
    return []
  }
}

async function matchUnblock(songId: number, sources: string[]): Promise<string | null> {
  const dir = unblockPackageDir()
  if (!dir) return null
  const { matchID } = require(dir) as {
    matchID: (id: string, source?: string) => Promise<{ code?: number; data?: { url?: string } }>
  }
  for (const source of sources) {
    try {
      const res = await matchID(String(songId), source)
      const url = res?.data?.url
      if (url && /^https?:\/\//.test(url)) return url
    } catch (err) {
      console.warn(`[unblock] ${source} failed for ${songId}:`, (err as Error).message)
    }
  }
  return null
}

// ---------- main entry ----------

function extFrom(type: unknown, url: string): string {
  const t = String(type ?? '').toLowerCase()
  if (t === 'flac' || t === 'mp3' || t === 'm4a' || t === 'aac' || t === 'ogg') return t
  const m = /\.(flac|mp3|m4a|aac|ogg|wav)(?:\?|$)/i.exec(url)
  return m?.[1]?.toLowerCase() ?? 'mp3'
}

/**
 * The only place that decides where a song's audio comes from.
 *
 * 1. NetEase gives a full-length URL (no trial clip)  -> use it.
 * 2. The song is VIP / paid (or NetEase only gives a trial clip) -> unavailable. Never unblocked.
 * 3. NetEase has no source at all and unblock is enabled -> try the configured third-party sources.
 */
export async function resolveAudio(song: Song): Promise<ResolvedAudio> {
  const settings = getSettings()
  const res = await call('song_url_v1', { id: song.id, level: settings.audioLevel })
  const data = res.body?.data?.[0] ?? {}
  const url: string | null = data.url ?? null
  const trial = data.freeTrialInfo ?? null

  if (url && trial === null) {
    return { url, source: 'netease', ext: extFrom(data.type, url) }
  }

  // song_url_v1 reports fee 0 for VIP songs the account can't play, so the
  // song's own fee (from song_detail) is the reliable signal here.
  const paid =
    isPaidFee(song.fee) || isPaidFee(Number(data.fee)) || trial !== null || song.playable === 'vip'
  if (paid) throw new UnavailableError('vip', '需要会员才能播放完整歌曲')

  if (!settings.unblockEnabled) throw new UnavailableError('no-source', '网易云暂无音源')
  const matched = await matchUnblock(song.id, settings.unblockSources)
  if (!matched) throw new UnavailableError('no-source', '网易云暂无音源，第三方音源也没有匹配到')
  return { url: matched, source: 'unblock', ext: extFrom(null, matched) }
}
