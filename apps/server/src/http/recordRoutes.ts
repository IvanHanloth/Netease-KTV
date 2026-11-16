import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { KEY_MAX, KEY_MIN } from '../shared/constants.js'
import {
  claimRecording,
  createRecording,
  finishRecording,
  MAX_TAKE_BYTES,
  recordingInfo,
  renderFile,
  requestRender,
  saveTake,
} from '../core/recordings.js'
import { sendFile } from './stream.js'

const recId = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{8,32}$/) })
const kind = z.enum(['audio', 'mv', 'lyrics'])

const segment = z.object({ rec: z.number().min(0), pos: z.number().min(0), dur: z.number().min(0) })
const createSchema = z.object({
  songId: z.number().int().positive(),
  key: z.number().int().min(KEY_MIN).max(KEY_MAX),
  singer: z.string().max(40).optional(),
  takes: z
    .array(z.object({ mime: z.string().max(80), segments: z.array(segment).max(500) }))
    .min(1)
    .max(20),
  latencyMs: z.number().min(0).max(1000),
  micVolume: z.number().min(0).max(1),
  musicVolume: z.number().min(0).max(1),
})

/** 录制 (see core/recordings.ts): uploads from the 主屏, and the phone page behind the QR code. */
export async function recordRoutes(app: FastifyInstance) {
  // Takes arrive as the raw MediaRecorder file.
  app.addContentTypeParser(/^(audio|video)\/|^application\/octet-stream/, { parseAs: 'buffer', bodyLimit: MAX_TAKE_BYTES }, (_req, body, done) =>
    done(null, body),
  )

  app.post('/', async (req) => createRecording(createSchema.parse(req.body)))
  app.put('/:id/takes/:n', { bodyLimit: MAX_TAKE_BYTES }, async (req) => {
    const { id } = recId.parse(req.params)
    const { n } = z.object({ n: z.coerce.number().int().min(0) }).parse(req.params)
    if (!Buffer.isBuffer(req.body)) return { error: '需要音频数据' }
    saveTake(id, n, req.body)
    return { ok: true }
  })
  app.post('/:id/finish', async (req) => finishRecording(recId.parse(req.params).id))

  // The phone page: opening it keeps the recording.
  app.get('/:id', async (req) => {
    const { id } = recId.parse(req.params)
    const { claim } = z.object({ claim: z.string().optional() }).parse(req.query)
    if (claim === '1') claimRecording(id)
    return recordingInfo(id)
  })
  app.post('/:id/render', async (req) => {
    const { id } = recId.parse(req.params)
    requestRender(id, kind.parse((req.body as { kind?: unknown } | undefined)?.kind))
    return recordingInfo(id)
  })
  app.get('/:id/files/:kind', async (req, reply) => {
    const { id } = recId.parse(req.params)
    const k = kind.parse((req.params as { kind: string }).kind)
    const { download } = z.object({ download: z.string().optional() }).parse(req.query)
    const { file, name } = renderFile(id, k)
    if (download === '1') reply.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`)
    return sendFile(req, reply, file)
  })
}
