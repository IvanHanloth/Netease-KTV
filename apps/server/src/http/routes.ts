import fs from 'node:fs'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import { config } from '../config.js'
import { hub } from '../core/hub.js'
import * as player from '../core/player.js'
import { retry } from '../core/pipeline.js'
import { renderPitch } from '../media/ffmpeg.js'
import { pitchedPath, pitchPath, stemFile } from '../media/files.js'
import { listUnblockSources } from '../media/resolve.js'
import { NcmError } from '../ncm/client.js'
import * as ncm from '../ncm/service.js'
import { addScore, leaderboard, resetScores, songRanking } from '../scores.js'
import { getSettings, updateSettings } from '../settings.js'
import type { PlayerCommand, Stem } from '../shared/types.js'
import { proxy, sendFile } from './stream.js'

const id = z.coerce.number().int().positive()
const page = z.object({
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(30),
})

export const commandSchema: z.ZodType<PlayerCommand> = z.union([
  z.object({ action: z.enum(['play', 'pause', 'toggle', 'next', 'restart']) }),
  z.object({ action: z.literal('seek'), position: z.number().min(0) }),
  z.object({
    action: z.literal('set'),
    musicVolume: z.number().min(0).max(1).optional(),
    vocalVolume: z.number().min(0).max(1).optional(),
    key: z.number().int().min(-6).max(6).optional(),
    trackMode: z.enum(['karaoke', 'original']).optional(),
    displayMode: z.enum(['stage', 'mv']).optional(),
  }),
]) as z.ZodType<PlayerCommand>

function fail(reply: FastifyReply, err: unknown) {
  if (err instanceof z.ZodError) return reply.code(400).send({ error: '参数错误', issues: err.issues })
  if (err instanceof NcmError) return reply.code(err.status).send({ error: err.message })
  console.error(err)
  return reply.code(500).send({ error: (err as Error).message ?? '服务器错误' })
}

const mvCache = new Map<number, { url: string; at: number }>()

export async function registerRoutes(app: FastifyInstance) {
  app.setErrorHandler((err, _req, reply) => fail(reply, err))

  // ---------- status ----------
  app.get('/api/health', async () => ({ ok: true, version: config.version }))
  app.get('/api/state', async () => player.snapshot())

  // ---------- account ----------
  app.get('/api/account', async () => ncm.getAccount())
  app.post('/api/auth/qr', async () => ncm.createQr())
  app.get('/api/auth/qr/:key', async (req) => {
    const { key } = z.object({ key: z.string().min(1) }).parse(req.params)
    return ncm.checkQr(key)
  })
  app.post('/api/auth/cookie', async (req) => {
    const { cookie } = z.object({ cookie: z.string().min(10) }).parse(req.body)
    return ncm.loginWithCookie(cookie)
  })
  app.post('/api/auth/logout', async () => {
    await ncm.logout()
    return { ok: true }
  })

  // ---------- library ----------
  app.get('/api/search', async (req) => {
    const q = z.object({ q: z.string().min(1) }).merge(page).parse(req.query)
    return ncm.search(q.q, q.offset, q.limit)
  })
  app.get('/api/search/suggest', async (req) => {
    const { q } = z.object({ q: z.string().default('') }).parse(req.query)
    return { keywords: q.trim() ? await ncm.suggest(q.trim()) : [] }
  })
  app.get('/api/recommend', async () => ncm.recommend())
  app.get('/api/playlists', async () => ({ playlists: await ncm.userPlaylists() }))
  app.get('/api/toplists', async () => ({ playlists: await ncm.toplists() }))
  app.get('/api/playlists/:id/tracks', async (req) => {
    const { id: pid } = z.object({ id }).parse(req.params)
    const q = page.extend({ limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(req.query)
    return ncm.playlistTracks(pid, q.offset, q.limit)
  })
  app.get('/api/songs/:id', async (req) => {
    const p = z.object({ id }).parse(req.params)
    return ncm.getSong(p.id)
  })
  app.get('/api/songs/:id/lyrics', async (req) => {
    const p = z.object({ id }).parse(req.params)
    return ncm.lyrics(p.id)
  })
  app.get('/api/songs/:id/mv', async (req, reply) => {
    const p = z.object({ id }).parse(req.params)
    const song = await ncm.getSong(p.id)
    if (!song.mvId) return reply.code(404).send({ error: '这首歌没有 MV' })
    return { mvId: song.mvId, url: `/api/mv/${song.mvId}/stream` }
  })
  app.get('/api/mv/:id/stream', async (req, reply) => {
    const p = z.object({ id }).parse(req.params)
    let cached = mvCache.get(p.id)
    if (!cached || Date.now() - cached.at > 10 * 60 * 1000) {
      cached = { url: await ncm.mvUrl(p.id), at: Date.now() }
      mvCache.set(p.id, cached)
    }
    return proxy(req, reply, cached.url)
  })
  app.get('/api/img', async (req, reply) => {
    const q = z.object({ u: z.string().url(), s: z.coerce.number().int().min(32).max(1200).optional() }).parse(req.query)
    const url = new URL(q.u)
    if (!/(^|\.)music\.126\.net$/.test(url.hostname)) return reply.code(400).send({ error: '只允许网易云图片地址' })
    url.protocol = 'https:'
    if (q.s) url.searchParams.set('param', `${q.s}y${q.s}`)
    return proxy(req, reply, url.toString(), {}, 'public, max-age=604800')
  })

  // ---------- queue ----------
  app.post('/api/queue', async (req, reply) => {
    const body = z
      .object({
        songId: id,
        position: z.enum(['end', 'next', 'now']).default('end'),
        addedBy: z.string().max(40).optional(),
      })
      .parse(req.body)
    const song = await ncm.getSong(body.songId, true)
    if (song.playable === 'vip') return reply.code(409).send({ error: '需要会员才能播放完整歌曲' })
    if (song.playable === 'no-source' && !getSettings().unblockEnabled) {
      return reply.code(409).send({ error: '网易云暂无音源（可在设置中开启第三方音源）' })
    }
    return player.addToQueue(song, body.position, body.addedBy)
  })
  app.post('/api/queue/:uid/play', async (req, reply) => {
    const { uid } = z.object({ uid: z.string() }).parse(req.params)
    return player.playNow(uid) ? { ok: true } : reply.code(404).send({ error: '不在队列中' })
  })
  app.post('/api/queue/:uid/top', async (req, reply) => {
    const { uid } = z.object({ uid: z.string() }).parse(req.params)
    return player.moveToTop(uid) ? { ok: true } : reply.code(404).send({ error: '不在队列中' })
  })
  app.post('/api/queue/reorder', async (req) => {
    const { uids } = z.object({ uids: z.array(z.string()) }).parse(req.body)
    player.reorder(uids)
    return { ok: true }
  })
  app.delete('/api/queue/:uid', async (req, reply) => {
    const { uid } = z.object({ uid: z.string() }).parse(req.params)
    return player.removeFromQueue(uid) ? { ok: true } : reply.code(404).send({ error: '不在队列中' })
  })
  app.delete('/api/queue', async () => {
    player.clearQueue()
    return { ok: true }
  })

  // ---------- player ----------
  app.post('/api/player/command', async (req) => {
    player.command(commandSchema.parse(req.body))
    return player.getPlayer()
  })

  // ---------- media ----------
  app.get('/api/media/:id/pitch', async (req, reply) => {
    const p = z.object({ id }).parse(req.params)
    const file = pitchPath(p.id)
    if (!fs.existsSync(file)) return reply.code(404).send({ error: '还没有参考音高' })
    return sendFile(req, reply, file)
  })
  app.get('/api/media/:id/:stem', async (req, reply) => {
    const p = z.object({ id, stem: z.enum(['instrumental', 'vocals', 'original']) }).parse(req.params)
    const { key } = z.object({ key: z.coerce.number().int().min(-6).max(6).default(0) }).parse(req.query)
    const file = stemFile(p.id, p.stem as Stem)
    if (!file) return reply.code(404).send({ error: '音频还没有准备好' })
    if (key === 0) return sendFile(req, reply, file)
    const pitched = pitchedPath(p.id, p.stem as Stem, key)
    if (!fs.existsSync(pitched)) await renderPitch(file, pitched, key)
    return sendFile(req, reply, pitched)
  })
  app.post('/api/tracks/:id/retry', async (req) => {
    const p = z.object({ id }).parse(req.params)
    retry(p.id)
    return hub.getTrack(p.id)
  })

  // ---------- scores / leaderboard ----------
  app.post('/api/scores', async (req) => {
    const body = z
      .object({
        songId: id,
        score: z.number().min(0).max(100),
        tolerance: z.number().min(0.1).max(5),
        singer: z.string().max(40).optional(),
      })
      .parse(req.body)
    return addScore(body)
  })
  app.get('/api/scores', async () => ({ songs: await leaderboard() }))
  app.get('/api/scores/:id', async (req, reply) => {
    const p = z.object({ id }).parse(req.params)
    const ranking = await songRanking(p.id)
    return ranking ?? reply.code(404).send({ error: '这首歌还没有成绩' })
  })
  app.delete('/api/scores', async () => ({ removed: resetScores() }))
  app.delete('/api/scores/:id', async (req) => {
    const p = z.object({ id }).parse(req.params)
    return { removed: resetScores(p.id) }
  })

  // ---------- settings ----------
  app.get('/api/settings', async () => ({ ...getSettings(), unblockSourceOptions: listUnblockSources() }))
  app.put('/api/settings', async (req) => {
    const body = z
      .object({
        unblockEnabled: z.boolean().optional(),
        unblockSources: z.array(z.string()).optional(),
        audioLevel: z.enum(['standard', 'higher', 'exhigh', 'lossless', 'hires']).optional(),
        separatorModel: z.string().max(200).optional(),
        publicUrl: z.string().max(200).optional(),
        scoringEnabled: z.boolean().optional(),
        scoreTolerance: z.number().min(0.3).max(3).optional(),
      })
      .parse(req.body)
    const sources = listUnblockSources()
    return { ...updateSettings(body, sources), unblockSourceOptions: sources }
  })
}
