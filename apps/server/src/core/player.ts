import { randomUUID } from 'node:crypto'
import { getDb, kv } from '../db.js'
import type { AppState, PlayerCommand, PlayerState, QueueItem, QueuePosition, Song } from '../shared/types.js'
import { hub } from './hub.js'

const PLAYER_KEY = 'player'

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

let queue: QueueItem[] = []
let player: PlayerState = {
  current: null,
  playing: false,
  position: 0,
  positionAt: Date.now(),
  musicVolume: 0.85,
  vocalVolume: 0,
  key: 0,
  trackMode: 'karaoke',
  displayMode: 'stage',
  leadVocal: false,
  epoch: 0,
}

// ---------- persistence ----------

function saveQueue(): void {
  const db = getDb()
  db.exec('BEGIN')
  try {
    db.prepare('DELETE FROM queue').run()
    const stmt = db.prepare('INSERT INTO queue (uid, song_id, position, added_at, added_by) VALUES (?, ?, ?, ?, ?)')
    queue.forEach((q, i) => stmt.run(q.uid, q.song.id, i, q.addedAt, q.addedBy ?? null))
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

function savePlayer(): void {
  kv.set(PLAYER_KEY, {
    current: player.current,
    musicVolume: player.musicVolume,
    vocalVolume: player.vocalVolume,
    trackMode: player.trackMode,
    displayMode: player.displayMode,
    leadVocal: player.leadVocal,
    position: player.position,
  })
}

export function loadPlayer(getSong: (id: number) => Song | undefined): void {
  const saved = kv.get<Partial<PlayerState>>(PLAYER_KEY)
  if (saved) {
    player = {
      ...player,
      current: saved.current ?? null,
      musicVolume: saved.musicVolume ?? player.musicVolume,
      vocalVolume: saved.vocalVolume ?? player.vocalVolume,
      trackMode: saved.trackMode ?? player.trackMode,
      displayMode: saved.displayMode ?? player.displayMode,
      leadVocal: saved.leadVocal ?? player.leadVocal,
      position: saved.position ?? 0,
      playing: false,
      positionAt: Date.now(),
    }
  }
  const rows = getDb().prepare('SELECT * FROM queue ORDER BY position').all() as any[]
  queue = rows
    .map((r): QueueItem | null => {
      const song = getSong(r.song_id)
      return song ? { uid: r.uid, song, addedAt: r.added_at, addedBy: r.added_by ?? undefined } : null
    })
    .filter((q): q is QueueItem => !!q)
}

// ---------- broadcast helpers ----------

function emitQueue(): void {
  saveQueue()
  hub.broadcast({ type: 'queue', queue })
  hub.emit('work')
}

function emitPlayer(): void {
  savePlayer()
  hub.broadcast({ type: 'player', player })
}

export function getQueue(): QueueItem[] {
  return queue
}

export function getPlayer(): PlayerState {
  return player
}

export function snapshot(): AppState {
  return {
    queue,
    player,
    tracks: hub.tracksRecord(),
    separator: hub.separator,
    tvOnline: hub.tvOnline,
  }
}

/** Song ids in the order their accompaniment is needed. */
export function priorityIds(): number[] {
  const ids: number[] = []
  if (player.current) ids.push(player.current.song.id)
  for (const q of queue) if (!ids.includes(q.song.id)) ids.push(q.song.id)
  return ids
}

// ---------- queue operations ----------

export const ANONYMOUS = '匿名'

export function addToQueue(song: Song, position: QueuePosition = 'end', addedBy?: string): QueueItem {
  const item: QueueItem = { uid: randomUUID(), song, addedAt: Date.now(), addedBy: addedBy?.trim() || ANONYMOUS }
  // Nothing playing: start right away.
  if (!player.current) {
    startItem(item)
    hub.emit('work')
    return item
  }
  if (position === 'next') queue = [item, ...queue]
  else queue = [...queue, item]
  emitQueue()
  return item
}

export function moveToTop(uid: string): boolean {
  const idx = queue.findIndex((q) => q.uid === uid)
  if (idx < 0) return false
  const [item] = queue.splice(idx, 1)
  queue = [item!, ...queue]
  emitQueue()
  return true
}

export function reorder(uids: string[]): void {
  const byUid = new Map(queue.map((q) => [q.uid, q]))
  const next: QueueItem[] = []
  for (const uid of uids) {
    const item = byUid.get(uid)
    if (item) {
      next.push(item)
      byUid.delete(uid)
    }
  }
  queue = [...next, ...byUid.values()]
  emitQueue()
}

export function removeFromQueue(uid: string): boolean {
  const before = queue.length
  queue = queue.filter((q) => q.uid !== uid)
  if (queue.length === before) return false
  emitQueue()
  return true
}

export function clearQueue(): void {
  queue = []
  emitQueue()
}

/** Shuffle the whole queue (Fisher–Yates). The current song keeps playing. */
export function shuffleQueue(): void {
  const next = [...queue]
  for (let i = next.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[next[i], next[j]] = [next[j]!, next[i]!]
  }
  queue = next
  emitQueue()
}

// ---------- playback ----------

function startItem(item: QueueItem | null): void {
  player = {
    ...player,
    current: item,
    playing: !!item,
    position: 0,
    positionAt: Date.now(),
    key: 0,
    epoch: player.epoch + 1,
  }
  emitPlayer()
}

/** Advance to the next playable song in the queue. */
export function next(): void {
  let item: QueueItem | undefined
  while ((item = queue.shift())) {
    if (hub.getTrack(item.song.id).status !== 'unavailable') break
  }
  startItem(item ?? null)
  emitQueue()
}

export function command(cmd: PlayerCommand): void {
  switch (cmd.action) {
    case 'next':
      next()
      return
    case 'set': {
      if (typeof cmd.musicVolume === 'number') player.musicVolume = clamp(cmd.musicVolume, 0, 1)
      if (typeof cmd.vocalVolume === 'number') player.vocalVolume = clamp(cmd.vocalVolume, 0, 1)
      if (typeof cmd.key === 'number') player.key = clamp(Math.round(cmd.key), -6, 6)
      if (cmd.trackMode === 'karaoke' || cmd.trackMode === 'original') player.trackMode = cmd.trackMode
      if (cmd.displayMode === 'stage' || cmd.displayMode === 'mv') player.displayMode = cmd.displayMode
      if (typeof cmd.leadVocal === 'boolean') player.leadVocal = cmd.leadVocal
      player = { ...player }
      emitPlayer()
      return
    }
    case 'restart':
      if (!player.current) return
      if (!hub.tvOnline) {
        player = { ...player, position: 0, positionAt: Date.now() }
        emitPlayer()
      }
      hub.broadcast({ type: 'command', command: cmd })
      return
    default:
      if (!player.current) return
      // play / pause / toggle / seek are executed by the TV, which then reports back.
      if (!hub.tvOnline) {
        if (cmd.action === 'play') player = { ...player, playing: true }
        else if (cmd.action === 'pause') player = { ...player, playing: false }
        else if (cmd.action === 'toggle') player = { ...player, playing: !player.playing }
        else if (cmd.action === 'seek') player = { ...player, position: Math.max(0, cmd.position), positionAt: Date.now() }
        emitPlayer()
      }
      hub.broadcast({ type: 'command', command: cmd })
  }
}

let lastReportBroadcast = 0

/** Position report from the TV. */
export function report(position: number, playing: boolean): void {
  if (!player.current) return
  const changed = playing !== player.playing
  player = { ...player, position: Math.max(0, position), positionAt: Date.now(), playing }
  const now = Date.now()
  if (changed || now - lastReportBroadcast > 900) {
    lastReportBroadcast = now
    hub.broadcast({ type: 'player', player })
  }
  // Persist on play/pause changes and every few seconds, so a restart resumes near where it was.
  if (changed || now - lastSave > 5000) {
    lastSave = now
    savePlayer()
  }
}

let lastSave = 0

export function ended(): void {
  next()
}

// Skip the current song if its audio turns out to be unavailable.
hub.on('unavailable', (songId: number) => {
  if (player.current?.song.id === songId) next()
})
