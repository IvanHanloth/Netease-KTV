import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { paths } from '../config.js'
import { call, getCookie } from '../ncm/client.js'
import { ffmpegJob, probeChannels } from './ffmpeg.js'
import { BROWSER_UA, download, ensureMediaDir, officialMarkPath, stemPath } from './files.js'

/**
 * NetEase 随心唱: for many songs the app can turn the lead vocal down, because NetEase keeps the
 * song as two stereo stems in one 4-channel AAC file (ch 0+1 伴奏, ch 2+3 人声), time-aligned with
 * the normal track. The player URL endpoint returns it when asked with `accompany: true`; a song
 * without one comes back with no URL. Same entitlement as normal playback: the account must be
 * able to play the song (the caller only asks for songs NetEase itself already gave us).
 *
 * The 伴奏 has no backing vocals (unlike the karaoke separation models, which keep them).
 */

const require = createRequire(import.meta.url)
const { cookieToJson } = require('@neteasecloudmusicapienhanced/api/util/index.js') as {
  cookieToJson: (cookie: string) => Record<string, string>
}

/**
 * As the Android app. The web client with this extra parameter has tripped NetEase's risk check
 * (-460); the app client is what the feature is built for.
 */
function appCookie(): Record<string, string> {
  return { ...cookieToJson(getCookie()), os: 'android', appver: '9.3.40' }
}

/** The 随心唱 file's URL and size, or null when the song has none. */
async function officialUrl(songId: number): Promise<{ url: string; size: number } | null> {
  const res = await call('api', {
    uri: '/api/song/enhance/player/url/v1',
    data: { ids: `[${songId}]`, level: 'exhigh', encodeType: 'aac', accompany: true },
    crypto: 'eapi',
    cookie: appCookie(),
  })
  const d = res.body?.data?.[0]
  if (d?.accompany !== true || typeof d.url !== 'string' || !d.url || d.freeTrialInfo) return null
  return { url: d.url, size: Number(d.size) || 0 }
}

const CHUNK = 1024 * 1024
const PARALLEL = 10
const CHUNK_TRIES = 4

/**
 * The 随心唱 CDN caps each connection at ~160 KB/s (a 20 MB file would take two minutes), but
 * serves byte ranges: fetch 1 MB pieces over several connections, written in place.
 */
async function downloadRanged(url: string, size: number, dest: string, onProgress?: (p: number) => void): Promise<void> {
  const fh = await fs.promises.open(dest, 'w')
  try {
    let next = 0
    let done = 0
    const piece = async (start: number) => {
      const end = Math.min(size, start + CHUNK) - 1
      for (let attempt = 1; ; attempt++) {
        try {
          const res = await fetch(url, {
            headers: { 'User-Agent': BROWSER_UA, Range: `bytes=${start}-${end}` },
            signal: AbortSignal.timeout(60_000),
          })
          if (res.status !== 206) throw new Error(`HTTP ${res.status}`)
          const buf = Buffer.from(await res.arrayBuffer())
          if (buf.length !== end - start + 1) throw new Error('分块不完整')
          await fh.write(buf, 0, buf.length, start)
          done += buf.length
          onProgress?.(done / size)
          return
        } catch (err) {
          if (attempt >= CHUNK_TRIES) throw new Error(`下载官方伴奏失败：${(err as Error).message}`)
          await new Promise((r) => setTimeout(r, 500 * attempt))
        }
      }
    }
    const worker = async () => {
      while (next < size) {
        const start = next
        next += CHUNK
        await piece(start)
      }
    }
    await Promise.all(Array.from({ length: Math.min(PARALLEL, Math.ceil(size / CHUNK)) }, worker))
  } finally {
    await fh.close()
  }
}

/**
 * Fetch a song's 随心唱 stems into its media dir as instrumental.flac + vocals.flac (and the
 * official marker). False when NetEase has none for it; throws when fetching or splitting failed.
 */
export async function fetchOfficialStems(songId: number, onProgress?: (p: number) => void): Promise<boolean> {
  const found = await officialUrl(songId)
  if (!found) return false
  const tmp = path.join(paths.tmp(), `official-${songId}-${Date.now()}.m4a`)
  ensureMediaDir(songId)
  const inst = stemPath(songId, 'instrumental')
  const voc = stemPath(songId, 'vocals')
  // `.part.flac`: ffmpeg picks the format from the extension, the cache sees an unfinished write.
  const part = (f: string) => f.replace(/\.flac$/, '.part.flac')
  try {
    fs.mkdirSync(paths.tmp(), { recursive: true })
    const progress = (p: number) => onProgress?.(p * 0.85)
    if (found.size > 0) await downloadRanged(found.url, found.size, tmp, progress)
    else await download(found.url, tmp, progress)
    const channels = await probeChannels(tmp)
    if (channels !== 4) throw new Error(`官方伴奏格式不认识（${channels} 声道）`)
    await ffmpegJob([
      '-i', tmp,
      '-filter_complex', '[0:a]pan=stereo|c0=c0|c1=c1[i];[0:a]pan=stereo|c0=c2|c1=c3[v]',
      '-map', '[i]', '-c:a', 'flac', part(inst),
      '-map', '[v]', '-c:a', 'flac', part(voc),
    ])
    fs.renameSync(part(inst), inst)
    fs.renameSync(part(voc), voc)
    fs.writeFileSync(officialMarkPath(songId), '')
    onProgress?.(1)
    return true
  } catch (err) {
    for (const f of [part(inst), part(voc)]) fs.rmSync(f, { force: true })
    throw err
  } finally {
    fs.rmSync(tmp, { force: true })
  }
}
