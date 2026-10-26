import { create } from 'zustand'
import type {
  AppState,
  ClientMessage,
  ClientRole,
  IdleSync,
  PlaybackSync,
  PlayerCommand,
  PlayerState,
  ServerMessage,
} from '@shared/types'
import { withToken } from '../lib/api'
import { handlePong, startClockSync, stopClockSync } from '../lib/clock'

type CommandListener = (command: PlayerCommand) => void

const defaultPlayer: PlayerState = {
  current: null,
  playing: false,
  position: 0,
  positionAt: 0,
  musicVolume: 0.8,
  vocalVolume: 0.3,
  key: 0,
  trackMode: 'karaoke',
  displayMode: 'stage',
  leadVocal: false,
  epoch: 0,
  idleVolume: 0.4,
}

export const emptyState: AppState = {
  queue: [],
  player: defaultPlayer,
  tracks: {},
  separator: { online: false, pending: 0 },
  tvOnline: false,
}

interface Store {
  state: AppState
  connected: boolean
  /** True once the first full state has arrived. */
  ready: boolean
  /** TV pages only: whether this page is the one TV allowed to play audio (null = not told yet). */
  tvActive: boolean | null
  /** Bumped on every `{type:'scores'}` message so leaderboard queries refetch. */
  scoresVersion: number
  /** Bumped on every `{type:'history'}` message so 点歌记录 refetches. */
  historyVersion: number
  /** Bumped on every `{type:'settings'}` message (main.tsx refetches settings queries). */
  settingsVersion: number
  /** 耳返 only: the TV's latest position report. */
  sync: PlaybackSync | null
  /** TV pages: the 主屏's 待机音乐 (what the other 大屏 show and follow). */
  idleSync: IdleSync | null
  apply: (msg: ServerMessage) => void
  setConnected: (v: boolean) => void
}

export const useApp = create<Store>((set) => ({
  state: emptyState,
  connected: false,
  ready: false,
  tvActive: null,
  scoresVersion: 0,
  historyVersion: 0,
  sync: null,
  idleSync: null,
  settingsVersion: 0,
  setConnected: (connected) => set({ connected }),
  apply: (msg) =>
    set((s) => {
      const st = s.state
      switch (msg.type) {
        case 'state':
          return { state: msg.state, ready: true }
        case 'queue':
          return { state: { ...st, queue: msg.queue } }
        case 'player':
          return { state: { ...st, player: msg.player } }
        case 'track':
          return { state: { ...st, tracks: { ...st.tracks, [msg.track.songId]: msg.track } } }
        case 'separator':
          return { state: { ...st, separator: msg.separator } }
        case 'tv':
          return { state: { ...st, tvOnline: msg.online } }
        case 'tvRole':
          return { tvActive: msg.active }
        case 'scores':
          return { scoresVersion: s.scoresVersion + 1 }
        case 'history':
          return { historyVersion: s.historyVersion + 1 }
        case 'sync':
          return { sync: msg.sync }
        case 'idle':
          return { idleSync: msg.idle }
        case 'settings':
          return { settingsVersion: s.settingsVersion + 1 }
        default:
          return {}
      }
    }),
}))

// ---- WebSocket connection (singleton) ----

let socket: WebSocket | null = null
let role: ClientRole = 'desk'
let retry = 0
let retryTimer: number | undefined
let started = false
const commandListeners = new Set<CommandListener>()
const outbox: ClientMessage[] = []

function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return proto + '//' + location.host + withToken('/api/ws')
}

/** The TV stamps its reports and 耳返 schedules audio on the server clock; others don't need it. */
function syncClock() {
  const ws = socket
  if ((role === 'tv' || role === 'ear') && ws?.readyState === WebSocket.OPEN) {
    startClockSync((id) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping', id } satisfies ClientMessage))
    })
  } else stopClockSync()
}

function open() {
  clearTimeout(retryTimer)
  const ws = new WebSocket(wsUrl())
  socket = ws
  ws.onopen = () => {
    retry = 0
    useApp.getState().setConnected(true)
    ws.send(JSON.stringify({ type: 'hello', role } satisfies ClientMessage))
    while (outbox.length) ws.send(JSON.stringify(outbox.shift()))
    syncClock()
  }
  ws.onmessage = (ev) => {
    let msg: ServerMessage
    try {
      msg = JSON.parse(String(ev.data))
    } catch {
      return
    }
    if (msg.type === 'pong') {
      handlePong(msg.id, msg.t)
      return
    }
    if (msg.type === 'command') {
      commandListeners.forEach((l) => l(msg.command))
      return
    }
    useApp.getState().apply(msg)
  }
  ws.onclose = () => {
    if (socket !== ws) return
    socket = null
    stopClockSync()
    useApp.getState().setConnected(false)
    const delay = Math.min(15000, 500 * 2 ** retry++)
    retryTimer = window.setTimeout(open, delay)
  }
  ws.onerror = () => ws.close()
}

/** Start (once) the shared connection with the given role. */
export function connect(r: ClientRole) {
  role = r
  if (started) {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'hello', role }))
    syncClock()
    return
  }
  started = true
  open()
}

/**
 * Send now; returns false when offline. Only the 大屏's own lifecycle messages (the latest claim,
 * a song end) wait for the reconnect: a user's command replayed later would be a surprise.
 */
export function sendMessage(msg: ClientMessage): boolean {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(msg))
    return true
  }
  if (msg.type === 'claim') {
    const i = outbox.findIndex((m) => m.type === 'claim')
    if (i >= 0) outbox.splice(i, 1)
    outbox.push(msg)
  } else if (msg.type === 'ended') outbox.push(msg)
  return false
}

/** Send a player command; false when offline (it is dropped, not queued). */
export function sendCommand(command: PlayerCommand): boolean {
  return sendMessage({ type: 'command', command })
}

export function onCommand(listener: CommandListener) {
  commandListeners.add(listener)
  return () => {
    commandListeners.delete(listener)
  }
}

/** Estimated live position (seconds) from the last report. */
export function livePosition(p: PlayerState, now = Date.now()) {
  if (!p.playing || !p.positionAt) return p.position
  return p.position + (now - p.positionAt) / 1000
}
