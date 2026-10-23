import type { FastifyReply } from 'fastify'
import { z } from 'zod'
import { CacheError } from '../core/storage.js'
import { UnavailableError } from '../media/resolve.js'
import { NcmError } from '../ncm/client.js'

/** An error a handler can throw to answer with a given status. */
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}

export const notFound = (message: string) => new HttpError(404, message)
export const conflict = (message: string) => new HttpError(409, message)

/** Map anything a route throws to a status and `{ error }` body; only real server faults are logged. */
export function sendError(reply: FastifyReply, err: unknown) {
  if (err instanceof z.ZodError) return reply.code(400).send({ error: '参数错误', issues: err.issues })
  if (err instanceof HttpError || err instanceof NcmError || err instanceof CacheError) {
    return reply.code(err.status).send({ error: err.message })
  }
  if (err instanceof UnavailableError) return reply.code(409).send({ error: err.message })
  // Fastify's own client errors (bad JSON body, payload too large, unsupported media type…).
  const status = (err as { statusCode?: number }).statusCode
  if (typeof status === 'number' && status >= 400 && status < 500) {
    return reply.code(status).send({ error: (err as Error).message })
  }
  console.error(err)
  return reply.code(500).send({ error: (err as Error).message || '服务器错误' })
}
