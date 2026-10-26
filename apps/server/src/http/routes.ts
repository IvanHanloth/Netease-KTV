import fs from 'node:fs'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { config } from '../config.js'
import { hub } from '../core/hub.js'
import * as player from '../core/player.js'
import { ensureOriginal, giveAnotherChance, retry } from '../core/pipeline.js'
import { renderPitch, renderPitchLater } from '../media/ffmpeg.js'
import { bypassCache } from '../apiCache.js'
import { busySong } from '../media/busy.js'
import { invalidateScan, touchFile, touchSong } from '../media/cache.js'
import { pitchedPath, pitchPath, stemFile } from '../media/files.js'
import { enqueueBlockReason, KEY_MAX, KEY_MIN } from '../shared/constants.js'
import { cachedMv, readAlignment } from '../media/mv.js'
import { listUnblockSources } from '../media/resolve.js'
import * as ncm from '../ncm/service.js'
import { listHistory, recordPick } from '../history.js'
import { addScore, leaderboard, resetScores, songRanking } from '../scores.js'
import { getSettings, updateSettings } from '../settings.js'
import type { IdleMusic, MvInfo, Song, Stem } from '../shared/types.js'
import { sendError } from './errors.js'
import { commandSchema } from './schemas.js'
import { adminRoutes } from './adminRoutes.js'
import { proxy, sendFile } from './stream.js'

const id = z.coerce.number().int().positive()
const page = z.object({
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(30),
})

export async function registerRoutes(app: FastifyInstance) {
  app.setErrorHandler((err, _req, reply) => sendError(reply, err))
  // ?fresh=1 (the desk's refresh button): this request skips the NetEase data cache.
  app.addHook('preHandler', (req, _reply, done) => {
    const fresh = (req.query as Record<string, unknown> | undefined)?.fresh
    if (fresh === '1') bypassCache.run(true, done)
    else done()
  })

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
  app.get('/api/albums/:id', async (req) => ncm.albumDetail(z.object({ id }).parse(req.params).id))
  app.get('/api/artists/:id', async (req) => ncm.artistDetail(z.object({ id }).parse(req.params).id))
  app.get('/api/artists/:id/songs', async (req) => {
    const { id: aid } = z.object({ id }).parse(req.params)
    const q = page.extend({ limit: z.coerce.number().int().min(1).max(100).default(50) }).parse(req.query)
    return ncm.artistSongs(aid, q.offset, q.limit)
  })
  app.get('/api/playlists', async () => ({ playlists: await ncm.userPlaylists() }))
  app.get('/api/toplists', async () => ({ playlists: await ncm.toplists() }))
  app.get('/api/playlists/resolve', async (req) => {
    const { q } = z.object({ q: z.string().min(1).max(2000) }).parse(req.query)
    return ncm.resolvePlaylist(q)
  })
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
  app.get('/api/songs/:id/mv', async (req, reply): Promise<MvInfo | undefined> => {
    const p = z.object({ id }).parse(req.params)
    const song = await ncm.getSong(p.id)
    if (!song.mvId) return reply.code(404).send({ error: '这首歌没有 MV' })
    const align = readAlignment(song.id, song.mvId)
    const cached = !!cachedMv(song.mvId)
    return {
      mvId: song.mvId,
      url: `/api/mv/${song.mvId}/stream`,
      cached,
      available: cached || !ncm.mvUnavailable(song.mvId),
      offset: align?.offset ?? null,
      confidence: align?.confidence ?? null,
    }
  })
  app.get('/api/mv/:id/stream', async (req, reply) => {
    const p = z.object({ id }).parse(req.params)
    const local = cachedMv(p.id)
    if (local) {
      touchFile(local)
      return sendFile(req, reply, local)
    }
    const res = getSettings().mvResolution
    const url = await ncm.mvStreamUrl(p.id, res)
    return proxy(req, reply, url, { onRefused: () => ncm.forgetLink(ncm.mvLinkKey(p.id, res)) })
  })
  app.get('/api/songs/:id/preview', async (req, reply) => {
    const p = z.object({ id }).parse(req.params)
    const url = await ncm.previewStreamUrl(p.id)
    return proxy(req, reply, url, { onRefused: () => ncm.forgetLink(ncm.previewLinkKey(p.id)) })
  })
  app.get('/api/img', async (req, reply) => {
    const q = z.object({ u: z.string().url(), s: z.coerce.number().int().min(32).max(1200).optional() }).parse(req.query)
    const url = new URL(q.u)
    if (!/(^|\.)music\.126\.net$/.test(url.hostname)) return reply.code(400).send({ error: '只允许网易云图片地址' })
    url.protocol = 'https:'
    if (q.s) url.searchParams.set('param', `${q.s}y${q.s}`)
    return proxy(req, reply, url.toString(), { cacheControl: 'public, max-age=604800' })
  })

  // ---------- queue ----------
  app.post('/api/queue', async (req, reply) => {
    const body = z
      .object({
        songId: id,
        position: z.enum(['end', 'next']).default('end'),
        addedBy: z.string().max(40).optional(),
      })
      .parse(req.body)
    const song = await ncm.getSong(body.songId, true)
    const blocked = enqueueBlockReason(song, getSettings().unblockEnabled)
    if (blocked) return reply.code(409).send({ error: blocked })
    giveAnotherChance(song.id)
    const item = player.addToQueue(song, body.position, body.addedBy)
    recordPick(song.id)
    return item
  })
  // ---------- 待机音乐 ----------
  app.get('/api/idle', async (): Promise<IdleMusic> => {
    const s = getSettings()
    const songs = s.idleSongs.length ? await ncm.getSongs(s.idleSongs).catch(() => []) : []
    const byId = new Map(songs.map((x) => [x.id, x]))
    return {
      enabled: s.idleEnabled,
      songs: s.idleSongs.map((id) => byId.get(id)).filter((x): x is Song => !!x),
    }
  })
  // Download an idle song's audio if needed (it is not queued, so the pipeline won't).
  app.post('/api/idle/:id/prepare', async (req, reply) => {
    const { id: songId } = z.object({ id }).parse(req.params)
    if (!getSettings().idleSongs.includes(songId)) return reply.code(404).send({ error: '不在待机音乐列表里' })
    await ensureOriginal(songId)
    return { ok: true }
  })

  // 点歌记录: latest 50 distinct songs, newest first.
  app.get('/api/history', async () => listHistory())
  app.post('/api/queue/:uid/top', async (req, reply) => {
    const { uid } = z.object({ uid: z.string() }).parse(req.params)
    return player.moveToTop(uid) ? { ok: true } : reply.code(404).send({ error: '不在队列中' })
  })
  app.post('/api/queue/shuffle', async () => {
    player.shuffleQueue()
    return { ok: true }
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
    const { key } = z.object({ key: z.coerce.number().int().min(KEY_MIN).max(KEY_MAX).default(0) }).parse(req.query)
    const stem = p.stem as Stem
    let file = stemFile(p.id, stem)
    // The original may have been cleared from the cache while the stems were kept: fetch it again.
    if (!file && stem === 'original' && hub.getTrack(p.id).status === 'ready') {
      await ensureOriginal(p.id)
      file = stemFile(p.id, stem)
    }
    if (!file) return reply.code(404).send({ error: '音频还没有准备好' })
    touchSong(p.id)
    if (key === 0) return sendFile(req, reply, file)
    const pitched = pitchedPath(p.id, stem, key)
    if (!fs.existsSync(pitched)) {
      await busySong(p.id, renderPitch(file, pitched, key))
      invalidateScan()
    }
    // The singer is adjusting the key: get the next steps either way ready in the background,
    // unless the song is no longer the one being sung by the time a render slot frees up.
    const stillCurrent = () => player.getPlayer().current?.song.id === p.id
    for (const k of [key + 1, key - 1]) {
      if (k !== 0 && k >= KEY_MIN && k <= KEY_MAX) renderPitchLater(file, pitchedPath(p.id, stem, k), k, stillCurrent)
    }
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

  // ---------- settings (desk) ----------
  // Everyone can read the settings (TV needs scoring + LAN address). The desk may only change the
  // singing options; everything that touches downloads, disk or the network lives under /api/admin.
  app.get('/api/settings', async () => ({ ...getSettings(), unblockSourceOptions: listUnblockSources() }))
  app.put('/api/settings', async (req) => {
    const body = z
      .object({
        scoringEnabled: z.boolean().optional(),
        scoreTolerance: z.number().min(0.3).max(3).optional(),
        multiScreenSync: z.boolean().optional(),
        multiScreenAudio: z.boolean().optional(),
      })
      .parse(req.body)
    return { ...updateSettings(body, listUnblockSources()), unblockSourceOptions: listUnblockSources() }
  })

  // 后台管理 (/admin): every ops endpoint lives under one prefix, in its own plugin.
  await app.register(adminRoutes, { prefix: '/api/admin' })
}
