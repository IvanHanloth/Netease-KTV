import fs from 'node:fs'
import path from 'node:path'
import cors from '@fastify/cors'
import fastifyStatic from '@fastify/static'
import websocket from '@fastify/websocket'
import Fastify from 'fastify'
import { config } from './config.js'
import { hub } from './core/hub.js'
import { startPipeline } from './core/pipeline.js'
import { loadPlayer } from './core/player.js'
import { getDb } from './db.js'
import { registerRoutes } from './http/routes.js'
import { registerWs } from './http/ws.js'
import { ffmpegAvailable } from './media/ffmpeg.js'
import { initNcm } from './ncm/client.js'
import { getCachedSong } from './ncm/service.js'

async function main() {
  fs.mkdirSync(config.dataDir, { recursive: true })
  getDb()
  hub.loadTracks()
  loadPlayer(getCachedSong)
  await initNcm()

  if (!(await ffmpegAvailable())) {
    console.warn('[ktv] ffmpeg not found — key change and duration checks will fail. Set FFMPEG_PATH.')
  }

  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' }, bodyLimit: 1024 * 1024 })
  await app.register(cors, { origin: true })
  await app.register(websocket)

  if (config.accessToken) {
    app.addHook('onRequest', async (req, reply) => {
      if (!req.url.startsWith('/api/') || req.url.startsWith('/api/health')) return
      const header = req.headers.authorization?.replace(/^Bearer\s+/i, '')
      const query = (req.query as Record<string, string> | undefined)?.token
      if (header !== config.accessToken && query !== config.accessToken) {
        return reply.code(401).send({ error: '需要访问令牌' })
      }
    })
  }

  await registerRoutes(app)
  await registerWs(app)

  // Serve the built web app with SPA fallback.
  const indexHtml = path.join(config.webDist, 'index.html')
  if (fs.existsSync(indexHtml)) {
    await app.register(fastifyStatic, { root: config.webDist, index: ['index.html'] })
    app.setNotFoundHandler((req, reply) => {
      const pathname = req.url.split('?')[0] ?? ''
      // Only page routes (/tv, /m, ...) fall back to the SPA; missing files stay 404.
      if (pathname.startsWith('/api/') || path.extname(pathname)) {
        return reply.code(404).send({ error: 'Not found' })
      }
      return reply.type('text/html').header('Cache-Control', 'no-cache').send(fs.createReadStream(indexHtml))
    })
  } else {
    app.log.warn(`web build not found at ${config.webDist}; run "npm run build -w @ktv/web" (API still works)`)
  }

  startPipeline()
  await app.listen({ port: config.port, host: config.host })
  app.log.info(`Netease KTV ready on http://localhost:${config.port}  (data: ${config.dataDir})`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
