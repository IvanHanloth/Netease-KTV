import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { BROWSER_UA } from '../media/files.js'

const TYPES: Record<string, string> = {
  '.flac': 'audio/flac',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.json': 'application/json; charset=utf-8',
  '.mp4': 'video/mp4',
}

/** Does any entity tag in an If-None-Match / If-Range header match ours? */
function etagMatches(header: string | undefined, etag: string): boolean {
  if (!header) return false
  if (header.trim() === '*') return true
  const bare = etag.replace(/^W\//, '')
  return header.split(',').some((t) => t.trim().replace(/^W\//, '') === bare)
}

/**
 * Send a local file with HTTP Range support and validators. Cached media can be replaced under
 * the same URL (re-separation, a cleared and re-downloaded original), so browsers revalidate
 * every time (`no-cache`) and get a cheap 304 when the file is unchanged.
 */
export function sendFile(req: FastifyRequest, reply: FastifyReply, file: string) {
  const stat = fs.statSync(file)
  const type = TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream'
  const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`
  const lastModified = stat.mtime.toUTCString()
  reply
    .header('Accept-Ranges', 'bytes')
    .header('Content-Type', type)
    .header('Cache-Control', 'private, no-cache')
    .header('ETag', etag)
    .header('Last-Modified', lastModified)

  const range = req.headers.range
  if (!range) {
    const inm = req.headers['if-none-match']
    const ims = req.headers['if-modified-since']
    const notModified = inm ? etagMatches(inm, etag) : !!ims && Date.parse(ims) >= Math.floor(stat.mtimeMs / 1000) * 1000
    if (notModified) return reply.code(304).send()
  }

  // A range of an older copy of the file is useless: send it whole instead.
  const ifRange = [req.headers['if-range']].flat()[0]
  const rangeValid = !ifRange || etagMatches(ifRange, etag) || ifRange === lastModified
  const m = range && rangeValid ? /bytes=(\d*)-(\d*)/.exec(range) : null
  if (m) {
    let start = m[1] ? Number(m[1]) : 0
    let end = m[2] ? Number(m[2]) : stat.size - 1
    if (!m[1] && m[2]) {
      start = Math.max(0, stat.size - Number(m[2]))
      end = stat.size - 1
    }
    if (start >= stat.size || end < start) {
      return reply.code(416).header('Content-Range', `bytes */${stat.size}`).send()
    }
    end = Math.min(end, stat.size - 1)
    reply
      .code(206)
      .header('Content-Range', `bytes ${start}-${end}/${stat.size}`)
      .header('Content-Length', String(end - start + 1))
    return reply.send(fs.createReadStream(file, { start, end }))
  }
  reply.header('Content-Length', String(stat.size))
  return reply.send(fs.createReadStream(file))
}

const PASS_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag']

/**
 * Proxy a remote resource (MV video, preview, cover image) through the server. `onRefused` runs
 * when the upstream answers with an error (e.g. to drop an expired signed URL).
 */
export async function proxy(
  req: FastifyRequest,
  reply: FastifyReply,
  url: string,
  opts: { cacheControl?: string; onRefused?: () => void } = {},
) {
  const headers: Record<string, string> = { 'User-Agent': BROWSER_UA }
  if (req.headers.range) headers.Range = req.headers.range
  const upstream = await fetch(url, { headers })
  if (!upstream.ok && upstream.status !== 206) {
    opts.onRefused?.()
    return reply.code(upstream.status === 404 ? 404 : 502).send({ error: `upstream ${upstream.status}` })
  }
  reply.code(upstream.status)
  for (const h of PASS_HEADERS) {
    const v = upstream.headers.get(h)
    if (v) reply.header(h, v)
  }
  reply.header('Cache-Control', opts.cacheControl ?? 'private, max-age=600')
  if (!upstream.body) return reply.send()
  return reply.send(Readable.fromWeb(upstream.body as any))
}
