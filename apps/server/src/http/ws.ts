import type { FastifyInstance } from 'fastify'
import { hub } from '../core/hub.js'
import * as player from '../core/player.js'
import type { ClientMessage, ClientRole, ServerMessage } from '../shared/types.js'
import { commandSchema } from './routes.js'

/**
 * TV registry. Several TV pages may be open (another browser, a forgotten tab), but only
 * one may play audio — otherwise the song is heard twice and every song end is reported
 * twice (skipping a song). The active TV is the last one the user started ("claim");
 * a TV that connects while none is active becomes active right away.
 */
interface TvConn {
  id: number
  send: (msg: ServerMessage) => void
}

const tvs: TvConn[] = []
let activeTv: number | null = null
let nextId = 1

function announceRoles(): void {
  for (const tv of tvs) tv.send({ type: 'tvRole', active: tv.id === activeTv })
}

function syncTvCount(): void {
  hub.tvClients = tvs.length
  hub.broadcast({ type: 'tv', online: hub.tvOnline })
}

function addTv(tv: TvConn): void {
  if (!tvs.includes(tv)) tvs.push(tv)
  if (activeTv === null) activeTv = tv.id
  syncTvCount()
  announceRoles()
}

function removeTv(tv: TvConn): void {
  const idx = tvs.indexOf(tv)
  if (idx < 0) return
  tvs.splice(idx, 1)
  // Hand audio to the most recently opened remaining TV (it still needs a click to start).
  if (activeTv === tv.id) activeTv = tvs.at(-1)?.id ?? null
  syncTvCount()
  announceRoles()
}

function claim(tv: TvConn): void {
  if (!tvs.includes(tv) || activeTv === tv.id) {
    tv.send({ type: 'tvRole', active: activeTv === tv.id })
    return
  }
  activeTv = tv.id
  announceRoles()
}

export async function registerWs(app: FastifyInstance) {
  app.get('/api/ws', { websocket: true }, (socket) => {
    let role: ClientRole | null = null

    const send = (msg: ServerMessage) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg))
    }
    const tv: TvConn = { id: nextId++, send }
    const isActiveTv = () => role === 'tv' && activeTv === tv.id

    const onMessage = (msg: ServerMessage) => {
      // Playback commands are executed by the active TV only.
      if (msg.type === 'command' && !isActiveTv()) return
      send(msg)
    }
    hub.on('message', onMessage)

    socket.on('message', (raw: unknown) => {
      let msg: ClientMessage
      try {
        msg = JSON.parse(String(raw)) as ClientMessage
      } catch {
        return
      }
      switch (msg.type) {
        case 'hello':
          send({ type: 'state', state: player.snapshot() })
          if (msg.role === 'tv') addTv(tv)
          else if (role === 'tv') removeTv(tv)
          role = msg.role
          if (role === 'tv') send({ type: 'tvRole', active: activeTv === tv.id })
          break
        case 'claim':
          if (role === 'tv') claim(tv)
          break
        case 'command': {
          const parsed = commandSchema.safeParse(msg.command)
          if (parsed.success) player.command(parsed.data)
          break
        }
        case 'report':
          if (isActiveTv() && typeof msg.position === 'number') player.report(msg.position, !!msg.playing)
          break
        case 'ended':
          if (isActiveTv()) player.ended()
          break
      }
    })

    const ping = setInterval(() => {
      if (socket.readyState === socket.OPEN) socket.ping()
    }, 25_000)

    socket.on('close', () => {
      clearInterval(ping)
      hub.off('message', onMessage)
      if (role === 'tv') removeTv(tv)
    })
  })
}
