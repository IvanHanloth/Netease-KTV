import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import type { FastifyReply, FastifyRequest } from 'fastify'

const TYPES: Record<string, string> = {
  '.flac': 'audio/flac',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
}

/** Send a local file with HTTP Range support. */
export function sendFile(req: FastifyRequest, reply: FastifyReply, file: string) {
  const stat = fs.statSync(file)
  const type = TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream'
  reply.header('Accept-Ranges', 'bytes').header('Content-Type', type).header('Cache-Control', 'private, max-age=86400')
  const range = req.headers.range
  const m = range ? /bytes=(\d*)-(\d*)/.exec(range) : null
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

/** Proxy a remote resource (MV video, cover image) through the server. */
export async function proxy(
  req: FastifyRequest,
  reply: FastifyReply,
  url: string,
  extraHeaders: Record<string, string> = {},
  cacheControl = 'private, max-age=600',
) {
  const headers: Record<string, string> = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    ...extraHeaders,
  }
  if (req.headers.range) headers.Range = req.headers.range
  const upstream = await fetch(url, { headers })
  if (!upstream.ok && upstream.status !== 206) {
    return reply.code(upstream.status === 404 ? 404 : 502).send({ error: `upstream ${upstream.status}` })
  }
  reply.code(upstream.status)
  for (const h of PASS_HEADERS) {
    const v = upstream.headers.get(h)
    if (v) reply.header(h, v)
  }
  reply.header('Cache-Control', cacheControl)
  if (!upstream.body) return reply.send()
  return reply.send(Readable.fromWeb(upstream.body as any))
}
