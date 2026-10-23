import { create } from 'zustand'
import type {
  AppState,
  ClientMessage,
  ClientRole,
  PlayerCommand,
  PlayerState,
  ServerMessage,
} from '@shared/types'
import { withToken } from '../lib/api'

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
  apply: (msg: ServerMessage) => void
  setConnected: (v: boolean) => void
}

export const useApp = create<Store>((set) => ({
  state: emptyState,
  connected: false,
  ready: false,
  tvActive: null,
  scoresVersion: 0,
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

function open() {
  clearTimeout(retryTimer)
  const ws = new WebSocket(wsUrl())
  socket = ws
  ws.onopen = () => {
    retry = 0
    useApp.getState().setConnected(true)
    ws.send(JSON.stringify({ type: 'hello', role } satisfies ClientMessage))
    while (outbox.length) ws.send(JSON.stringify(outbox.shift()))
  }
  ws.onmessage = (ev) => {
    let msg: ServerMessage
    try {
      msg = JSON.parse(String(ev.data))
    } catch {
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
    return
  }
  started = true
  open()
}

export function sendMessage(msg: ClientMessage) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg))
  else if (msg.type !== 'report') outbox.push(msg)
}

export function sendCommand(command: PlayerCommand) {
  sendMessage({ type: 'command', command })
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
