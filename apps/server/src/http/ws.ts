import type { FastifyInstance } from 'fastify'
import { hub } from '../core/hub.js'
import * as player from '../core/player.js'
import type { ClientMessage, ClientRole, ServerMessage } from '../shared/types.js'
import { commandSchema } from './routes.js'

export async function registerWs(app: FastifyInstance) {
  app.get('/api/ws', { websocket: true }, (socket) => {
    let role: ClientRole | null = null

    const send = (msg: ServerMessage) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg))
    }
    const onMessage = (msg: ServerMessage) => {
      // Playback commands only matter to the TV.
      if (msg.type === 'command' && role !== 'tv') return
      send(msg)
    }
    hub.on('message', onMessage)

    const setTv = (on: boolean) => {
      hub.tvClients += on ? 1 : -1
      hub.broadcast({ type: 'tv', online: hub.tvOnline })
    }

    socket.on('message', (raw: unknown) => {
      let msg: ClientMessage
      try {
        msg = JSON.parse(String(raw)) as ClientMessage
      } catch {
        return
      }
      switch (msg.type) {
        case 'hello':
          if (role === 'tv' && msg.role !== 'tv') setTv(false)
          if (msg.role === 'tv' && role !== 'tv') setTv(true)
          role = msg.role
          send({ type: 'state', state: player.snapshot() })
          break
        case 'command': {
          const parsed = commandSchema.safeParse(msg.command)
          if (parsed.success) player.command(parsed.data)
          break
        }
        case 'report':
          if (role === 'tv' && typeof msg.position === 'number') player.report(msg.position, !!msg.playing)
          break
        case 'ended':
          if (role === 'tv') player.ended()
          break
      }
    })

    const ping = setInterval(() => {
      if (socket.readyState === socket.OPEN) socket.ping()
    }, 25_000)

    socket.on('close', () => {
      clearInterval(ping)
      hub.off('message', onMessage)
      if (role === 'tv') setTv(false)
    })
  })
}
