import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { config } from '../config.js'
import { hub } from '../core/hub.js'
import { refreshSeparators } from '../core/pipeline.js'
import {
  cacheInfo,
  clearAllMedia,
  clearData,
  clearMediaKind,
  clearSongMedia,
  enforceCacheLimit,
  listCachedSongs,
} from '../core/storage.js'
import { listUnblockSources } from '../media/resolve.js'
import { addNode, clusterSummary, getNodes, nodeViews, removeNode, testNode, updateNode } from '../separator.js'
import { updateSettings } from '../settings.js'
import { DATA_CACHE_KINDS, MEDIA_CACHE_KINDS, MV_RESOLUTIONS, SETTING_LIMITS, SOUND_LEVELS } from '../shared/constants.js'
import type { AdminStatus, DataCacheKind, MediaCacheKind } from '../shared/types.js'
import { clientCounts } from './ws.js'

const id = z.coerce.number().int().positive()

/**
 * 后台管理 endpoints, registered under /api/admin. No auth yet: with everything behind one prefix,
 * adding it is one hook here.
 */
export async function adminRoutes(app: FastifyInstance) {
  // ---------- admin (ops panel, /admin) ----------
  // No auth yet; keeping every ops endpoint under one prefix makes adding it a one-line hook.
  app.get('/status', async (): Promise<AdminStatus> => {
    const views = nodeViews()
    return {
      version: config.version,
      node: process.version,
      uptimeSec: Math.round(process.uptime()),
      dataDir: config.dataDir,
      separator: {
        ...clusterSummary(),
        pending: hub.separator.pending,
        busyNodes: views.filter((n) => n.jobs.some((j) => j.mode === 'separate')).length,
      },
      clients: clientCounts(),
      authEnabled: !!config.accessToken,
    }
  })

  // ---------- admin: separator servers ----------
  const nodeBody = z.object({
    name: z.string().trim().min(1).max(40),
    url: z.string().trim().regex(/^https?:\/\/[^\s/]+/i, '地址要以 http:// 或 https:// 开头').max(200),
    token: z.string().max(200).optional(),
    enabled: z.boolean().default(true),
    model: z.string().max(200).optional(),
  })
  app.get('/separators', async () => ({ nodes: nodeViews() }))
  app.post('/separators/test', async (req) => {
    const body = z.object({ url: z.string().max(200), token: z.string().max(200).optional(), id: z.string().optional() }).parse(req.body)
    // Editing an existing node without retyping its token: test with the stored one.
    const stored = body.id ? getNodes().find((n) => n.id === body.id)?.token : undefined
    return testNode(body.url, body.token || stored)
  })
  app.post('/separators', async (req) => {
    const body = nodeBody.parse(req.body)
    const node = addNode({ ...body, token: body.token || undefined, model: body.model || undefined })
    await refreshSeparators()
    return nodeViews().find((n) => n.id === node.id)
  })
  app.put('/separators/:id', async (req, reply) => {
    const { id: nodeId } = z.object({ id: z.string() }).parse(req.params)
    const body = nodeBody.partial().parse(req.body)
    const node = updateNode(nodeId, body)
    if (!node) return reply.code(404).send({ error: '分离服务器不存在' })
    await refreshSeparators()
    return nodeViews().find((n) => n.id === nodeId)
  })
  app.delete('/separators/:id', async (req, reply) => {
    const { id: nodeId } = z.object({ id: z.string() }).parse(req.params)
    if (!removeNode(nodeId)) return reply.code(404).send({ error: '分离服务器不存在' })
    await refreshSeparators()
    return { ok: true }
  })

  app.put('/settings', async (req) => {
    const body = z
      .object({
        unblockEnabled: z.boolean().optional(),
        unblockSources: z.array(z.string()).optional(),
        audioLevel: z.enum(SOUND_LEVELS).optional(),
        separatorModel: z.string().max(200).optional(),
        publicUrl: z.string().max(200).optional(),
        mvPreload: z.boolean().optional(),
        mvResolution: z.union(MV_RESOLUTIONS.map((r) => z.literal(r)) as [z.ZodLiteral<480>, z.ZodLiteral<720>, z.ZodLiteral<1080>]).optional(),
        cacheLimitGB: z.number().min(SETTING_LIMITS.cacheLimitGB.min).max(SETTING_LIMITS.cacheLimitGB.max).optional(),
        idleEnabled: z.boolean().optional(),
        idleSongs: z.array(z.number().int().positive()).max(SETTING_LIMITS.idleSongs.max).optional(),
      })
      .parse(req.body)
    const sources = listUnblockSources()
    const saved = updateSettings(body, sources)
    if (body.cacheLimitGB !== undefined) void enforceCacheLimit()
    if (body.mvPreload || body.mvResolution !== undefined) hub.emit('work-mv')
    return { ...saved, unblockSourceOptions: sources }
  })

  // ---------- admin: cache ----------
  // Clearing never touches the current / queued songs, 待机音乐 or files being written.
  app.get('/cache', async () => cacheInfo())
  app.get('/cache/songs', async () => ({ songs: await listCachedSongs() }))
  // All media (audio, stems, renders, MVs, leftovers).
  app.delete('/cache', async () => {
    const freed = await clearAllMedia()
    return { freed, cache: await cacheInfo() }
  })
  // All NetEase data (lists, search, lyrics, song details).
  app.delete('/cache/data', async () => {
    const removed = clearData()
    return { removed, cache: await cacheInfo() }
  })
  // One kind, media or data.
  app.delete('/cache/kinds/:kind', async (req) => {
    const { kind } = z
      .object({ kind: z.enum([...MEDIA_CACHE_KINDS, ...DATA_CACHE_KINDS] as [string, ...string[]]) })
      .parse(req.params)
    if ((MEDIA_CACHE_KINDS as readonly string[]).includes(kind)) {
      const freed = await clearMediaKind(kind as MediaCacheKind)
      return { freed, cache: await cacheInfo() }
    }
    const removed = clearData(kind as DataCacheKind)
    return { removed, cache: await cacheInfo() }
  })
  // One song: some kinds (?kinds=pitched,mv) or everything, its MV included.
  app.delete('/cache/songs/:id', async (req) => {
    const { id: songId } = z.object({ id }).parse(req.params)
    const { kinds } = z
      .object({ kinds: z.string().optional() })
      .parse(req.query)
    const list = kinds
      ? z.array(z.enum(MEDIA_CACHE_KINDS as unknown as [MediaCacheKind, ...MediaCacheKind[]])).parse(kinds.split(','))
      : undefined
    const freed = await clearSongMedia(songId, list)
    return { freed, cache: await cacheInfo() }
  })
}
