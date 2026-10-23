import type { FastifyInstance } from 'fastify'
import { hub } from '../core/hub.js'
import * as player from '../core/player.js'
import { serverNow } from '../clock.js'
import type { ClientMessage, ClientRole, PlaybackSync, ServerMessage } from '../shared/types.js'
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
/** Open sockets by the role they said hello with (for the ops panel). */
const roles = new Map<symbol, ClientRole>()

export function clientCounts(): Record<ClientRole, number> & { activeTv: boolean } {
  const out = { tv: 0, desk: 0, remote: 0, admin: 0, ear: 0 }
  for (const r of roles.values()) out[r]++
  return { ...out, activeTv: activeTv !== null }
}
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
    /** Heard from the client since the last heartbeat ping (see below). */
    let alive = true
    const key = Symbol('client')

    const send = (msg: ServerMessage) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg))
    }
    const tv: TvConn = { id: nextId++, send }
    const isActiveTv = () => role === 'tv' && activeTv === tv.id

    // 移动耳返 and silent extra screens follow the sound-playing TV's position reports.
    const onSync = (sync: PlaybackSync) => {
      if (role === 'ear' || (role === 'tv' && activeTv !== tv.id)) send({ type: 'sync', sync })
    }
    hub.on('sync', onSync)

    const onMessage = (msg: ServerMessage) => {
      // Playback commands are executed by the active TV only.
      if (msg.type === 'command' && !isActiveTv()) return
      send(msg)
    }
    hub.on('message', onMessage)

    socket.on('message', (raw: unknown) => {
      alive = true
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
          roles.set(key, role)
          if (role === 'tv') send({ type: 'tvRole', active: activeTv === tv.id })
          if (role === 'ear' || role === 'tv') {
            const sync = player.latestSync()
            if (sync) send({ type: 'sync', sync })
          }
          break
        case 'ping':
          send({ type: 'pong', id: msg.id, t: serverNow() })
          break
        case 'claim':
          if (role === 'tv') {
            claim(tv)
            // The new sound screen's own 舞台 / MV mode is what remotes now show and control.
            if (msg.displayMode === 'stage' || msg.displayMode === 'mv') player.command({ action: 'set', displayMode: msg.displayMode })
          }
          break
        case 'command': {
          const parsed = commandSchema.safeParse(msg.command)
          if (parsed.success) player.command(parsed.data)
          break
        }
        case 'report':
          if (isActiveTv() && typeof msg.position === 'number') {
            player.report(
              msg.position,
              !!msg.playing,
              typeof msg.at === 'number' ? msg.at : undefined,
              typeof msg.uid === 'string' ? msg.uid : undefined,
              typeof msg.epoch === 'number' ? msg.epoch : undefined,
            )
          }
          break
        case 'ended':
          if (isActiveTv()) player.ended()
          break
      }
    })

    // Heartbeat: a connection that died silently (TV asleep, Wi‑Fi dropped) never sends 'close'.
    // Without this a dead 主屏 would keep the role forever and every new 大屏 would open muted.
    // Two missed pongs (~20 s) and it is dropped, which hands 主屏 to another 大屏.
    socket.on('pong', () => (alive = true))
    const ping = setInterval(() => {
      if (socket.readyState !== socket.OPEN) return
      if (!alive) {
        socket.terminate()
        return
      }
      alive = false
      socket.ping()
    }, 10_000)

    socket.on('close', () => {
      clearInterval(ping)
      hub.off('message', onMessage)
      hub.off('sync', onSync)
      roles.delete(key)
      if (role === 'tv') removeTv(tv)
    })
  })
}
