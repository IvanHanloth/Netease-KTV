import type { FastifyInstance } from 'fastify'
import { hub } from '../core/hub.js'
import * as player from '../core/player.js'
import { serverNow } from '../clock.js'
import { kv } from '../db.js'
import type { ClientMessage, ClientRole, IdleSync, PlaybackSync, ScreenInfo, ScreenReport, ServerMessage } from '../shared/types.js'
import { clientMessageSchema, commandSchema } from './schemas.js'

/**
 * TV registry. Several TV pages may be open (another browser, a forgotten tab), but only
 * one may play audio — otherwise the song is heard twice and every song end is reported
 * twice (skipping a song). The active TV is the last one the user started ("claim");
 * a TV that connects while none is active becomes active right away.
 */
interface TvConn {
  id: number
  send: (msg: ServerMessage) => void
  /** 大屏 N, shown to people. */
  number: number
  /** The page's own id (kept in its browser): the same screen gets the same number back. */
  key?: string
  report?: ScreenReport
}

const NUMBERS_KEY = 'screenNumbers'

/** The number a 大屏 had before if it is free, otherwise the lowest free one. */
function assignNumber(tv: TvConn): void {
  const taken = new Set(tvs.filter((t) => t !== tv && t.number > 0).map((t) => t.number))
  const saved = tv.key ? kv.get<Record<string, number>>(NUMBERS_KEY)?.[tv.key] : undefined
  let n = saved && !taken.has(saved) ? saved : 1
  while (taken.has(n)) n++
  tv.number = n
  if (tv.key && saved !== n) {
    const all = kv.get<Record<string, number>>(NUMBERS_KEY) ?? {}
    all[tv.key] = n
    // Forget the oldest keys once there are many (browsers that are long gone).
    const keys = Object.keys(all)
    for (const k of keys.slice(0, Math.max(0, keys.length - 64))) delete all[k]
    kv.set(NUMBERS_KEY, all)
  }
}

const DEFAULT_REPORT: ScreenReport = { unlocked: false, displayMode: 'stage', muted: true, volume: 1, mic: null }

function screensList(): ScreenInfo[] {
  return tvs
    .map((t) => ({ ...(t.report ?? DEFAULT_REPORT), id: t.id, number: t.number, main: t.id === activeTv }))
    .sort((a, b) => a.number - b.number)
}

/** Every client but the 大屏 hears about the open 大屏 (the 点歌台 control panel lists them). */
function broadcastScreens(): void {
  const msg: ServerMessage = { type: 'screens', screens: screensList() }
  for (const c of conns.values()) {
    const r = c.role()
    if (r && r !== 'tv') c.send(msg)
  }
}

const tvs: TvConn[] = []
/** Every open socket by connection id (WebRTC signalling is addressed by it). */
const conns = new Map<number, { role: () => ClientRole | null; send: (msg: ServerMessage) => void }>()
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
  for (const tv of tvs) tv.send({ type: 'tvRole', active: tv.id === activeTv, number: tv.number })
  broadcastScreens()
}

/** Another 大屏 became the 主屏 (or the 主屏 left): its 待机音乐 holds where it was. */
function mainChanged(): void {
  player.freezeIdle()
  // Every TV hears where it stopped, the new 主屏 included (it continues from there).
  const idle = player.latestIdle()
  for (const tv of tvs) tv.send({ type: 'idle', idle })
  // 耳返 microphone return comes from the 主屏: phones reconnect to the new one.
  for (const c of conns.values()) if (c.role() === 'ear') c.send({ type: 'rtc', from: 0, signal: { kind: 'reset' } })
}

function syncTvCount(): void {
  hub.tvClients = tvs.length
  hub.broadcast({ type: 'tv', online: hub.tvOnline })
}

function addTv(tv: TvConn): void {
  if (!tvs.includes(tv)) tvs.push(tv)
  assignNumber(tv)
  if (activeTv === null) {
    activeTv = tv.id
    mainChanged()
  }
  syncTvCount()
  announceRoles()
}

function removeTv(tv: TvConn): void {
  const idx = tvs.indexOf(tv)
  if (idx < 0) return
  tvs.splice(idx, 1)
  // Hand audio to the most recently opened remaining TV (it still needs a click to start).
  if (activeTv === tv.id) {
    activeTv = tvs.at(-1)?.id ?? null
    mainChanged()
  }
  syncTvCount()
  announceRoles()
  // The sound screen is gone: the song pauses where it was instead of "playing" on unheard.
  if (activeTv === null) player.tvGone()
}

function claim(tv: TvConn): void {
  if (!tvs.includes(tv) || activeTv === tv.id) {
    tv.send({ type: 'tvRole', active: activeTv === tv.id, number: tv.number })
    return
  }
  activeTv = tv.id
  mainChanged()
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
    const tv: TvConn = { id: nextId++, send, number: 0 }
    const isActiveTv = () => role === 'tv' && activeTv === tv.id
    conns.set(tv.id, { role: () => role, send })

    // 移动耳返 and silent extra screens follow the sound-playing TV's position reports.
    const onSync = (sync: PlaybackSync) => {
      if (role === 'ear' || (role === 'tv' && activeTv !== tv.id)) send({ type: 'sync', sync })
    }
    hub.on('sync', onSync)
    // The 主屏's 待机音乐, for the other 大屏.
    const onIdle = (idle: IdleSync | null) => {
      if (role === 'tv' && activeTv !== tv.id) send({ type: 'idle', idle })
    }
    hub.on('idle', onIdle)

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
        const parsed = clientMessageSchema.safeParse(JSON.parse(String(raw)))
        if (!parsed.success) return
        msg = parsed.data
      } catch {
        return
      }
      switch (msg.type) {
        case 'hello':
          send({ type: 'state', state: player.snapshot() })
          role = msg.role
          roles.set(key, role)
          if (role === 'tv') {
            tv.key = msg.screenKey
            addTv(tv)
          } else {
            removeTv(tv)
            send({ type: 'screens', screens: screensList() })
          }
          if (role === 'ear' || role === 'tv') {
            const sync = player.latestSync()
            if (sync) send({ type: 'sync', sync })
          }
          if (role === 'tv') send({ type: 'idle', idle: player.latestIdle() })
          break
        case 'ping':
          send({ type: 'pong', id: msg.id, t: serverNow() })
          break
        case 'claim':
          if (role === 'tv') {
            claim(tv)
            // The new sound screen's own 舞台 / MV mode is what remotes now show and control.
            if (msg.displayMode) player.command({ action: 'set', displayMode: msg.displayMode })
          }
          break
        case 'command': {
          const parsed = commandSchema.safeParse(msg.command)
          if (parsed.success) player.command(parsed.data)
          break
        }
        case 'report':
          if (isActiveTv()) player.report(msg.position, msg.playing, msg.at, msg.uid, msg.epoch, msg.starting === true)
          break
        case 'ended':
          if (isActiveTv()) player.ended()
          break
        case 'idleReport':
          if (isActiveTv()) player.idleReport(msg.songId, msg.position, msg.playing, msg.at)
          break
        case 'screen':
          if (role === 'tv') {
            tv.report = msg.state
            broadcastScreens()
          }
          break
        case 'screenCommand': {
          // From a 点歌台 / remote to one 大屏. 设为主屏 happens here, and the screen is told too
          // so it can try to allow sound (a browser may still want a click on it).
          if (role === 'tv') break
          const target = tvs.find((t) => t.id === msg.to)
          if (!target) break
          if (msg.command.action === 'claim') claim(target)
          target.send({ type: 'screenCommand', command: msg.command })
          break
        }
        case 'rtc': {
          // 耳返 → a TV (the 主屏 unless one is named); TV → a 耳返. Nothing else is relayed.
          const toId = role === 'ear' ? (msg.to ?? activeTv) : role === 'tv' ? msg.to : undefined
          const target = toId != null ? conns.get(toId) : undefined
          if (!target || toId === tv.id) break
          if ((role === 'ear' && target.role() === 'tv') || (role === 'tv' && target.role() === 'ear')) {
            target.send({ type: 'rtc', from: tv.id, signal: msg.signal })
          }
          break
        }
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
      hub.off('idle', onIdle)
      roles.delete(key)
      conns.delete(tv.id)
      // The other side of any microphone-return connection lets it go.
      if (role === 'ear' && activeTv !== null) conns.get(activeTv)?.send({ type: 'rtc', from: tv.id, signal: { kind: 'bye' } })
      if (role === 'tv') removeTv(tv)
    })
  })
}
