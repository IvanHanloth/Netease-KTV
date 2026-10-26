import { randomUUID } from 'node:crypto'
import { getDb, kv } from '../db.js'
import { serverNow } from '../clock.js'
import type { AppState, IdleSync, PlaybackSync, PlayerCommand, PlayerState, QueueItem, QueuePosition, Song } from '../shared/types.js'
import { ANONYMOUS, KEY_MAX, KEY_MIN } from '../shared/constants.js'
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
  idleVolume: 0.4,
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
    idleVolume: player.idleVolume,
  })
}

export function loadPlayer(getSong: (id: number) => Song | undefined): void {
  const saved = kv.get<Partial<PlayerState>>(PLAYER_KEY)
  // Before 待机音乐 had its own volume it was a share of the accompaniment (a 后台 setting).
  const legacyShare = kv.get<{ idleVolume?: number }>('settings')?.idleVolume
  if (saved) {
    player = {
      ...player,
      current: saved.current ?? null,
      musicVolume: saved.musicVolume ?? player.musicVolume,
      vocalVolume: saved.vocalVolume ?? player.vocalVolume,
      trackMode: saved.trackMode ?? player.trackMode,
      displayMode: saved.displayMode ?? player.displayMode,
      leadVocal: saved.leadVocal ?? player.leadVocal,
      idleVolume:
        saved.idleVolume ??
        (typeof legacyShare === 'number' ? Math.round(clamp(legacyShare * (saved.musicVolume ?? player.musicVolume), 0, 1) * 100) / 100 : player.idleVolume),
      position: saved.position ?? 0,
      playing: false,
      positionAt: Date.now(),
    }
    // Keep the migrated level: the next settings save drops the old share.
    if (saved.idleVolume === undefined) savePlayer()
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
    // Not "playing" yet: the accompaniment may still be downloading / separating. The TV starts
    // the song from 0 once its audio is ready and then reports `playing`. Claiming playing here
    // made remotes extrapolate a position that never happened (and the TV resumed from it).
    playing: false,
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
      if (typeof cmd.key === 'number') player.key = clamp(Math.round(cmd.key), KEY_MIN, KEY_MAX)
      if (cmd.trackMode === 'karaoke' || cmd.trackMode === 'original') player.trackMode = cmd.trackMode
      if (cmd.displayMode === 'stage' || cmd.displayMode === 'mv') player.displayMode = cmd.displayMode
      if (typeof cmd.leadVocal === 'boolean') player.leadVocal = cmd.leadVocal
      if (typeof cmd.idleVolume === 'number') player.idleVolume = clamp(cmd.idleVolume, 0, 1)
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

/**
 * What clients last heard about the playhead. They extrapolate from it, so a report only needs
 * broadcasting when they would now be wrong: play / pause, another song or 重唱, or a jump
 * (seek, a stall) of more than 0.3 s. A refresh every 10 s bounds any slow drift.
 */
let lastBroadcast: { uid: string; epoch: number; position: number; at: number; playing: boolean; sent: number } | null = null
const DRIFT_S = 0.3
const REFRESH_MS = 10_000

/** Position report from the TV. */
let lastSync: PlaybackSync | null = null

/** The TV's latest position report (for 耳返 clients that just connected). */
export function latestSync(): PlaybackSync | null {
  return lastSync && lastSync.uid === player.current?.uid ? lastSync : null
}

export function report(position: number, playing: boolean, at?: number, uid?: string, epoch?: number, starting = false): void {
  const cur = player.current
  if (!cur) return
  // A report about the previous song (sent while the TV was switching) is ignored.
  if (uid !== undefined && (uid !== cur.uid || (epoch !== undefined && epoch !== player.epoch))) return
  const changed = playing !== player.playing
  const t = at !== undefined && Math.abs(at - serverNow()) < 5000 ? at : serverNow()
  player = { ...player, position: Math.max(0, position), positionAt: Math.round(t), playing }
  lastSync = { uid: cur.uid, epoch: player.epoch, position, at: t, playing, ...(starting ? { starting: true } : {}) }
  hub.emit('sync', lastSync)
  const now = Date.now()
  lastReportAt = now
  const lb = lastBroadcast
  const expected = lb ? lb.position + (lb.playing ? (t - lb.at) / 1000 : 0) : NaN
  const stale =
    !lb ||
    lb.playing !== playing ||
    lb.uid !== cur.uid ||
    lb.epoch !== player.epoch ||
    !(Math.abs(position - expected) <= DRIFT_S) ||
    now - lb.sent > REFRESH_MS
  if (stale) {
    lastBroadcast = { uid: cur.uid, epoch: player.epoch, position, at: t, playing, sent: now }
    hub.broadcast({ type: 'player', player })
  }
  // Persist on play/pause changes and every few seconds, so a restart resumes near where it was.
  if (changed || now - lastSave > 5000) {
    lastSave = now
    savePlayer()
  }
}

let lastSave = 0
/** Date.now() of the last report the active TV sent (it reports every second while it plays). */
let lastReportAt = 0

export function ended(): void {
  next()
}

// Skip the current song if its audio turns out to be unavailable.
hub.on('unavailable', (songId: number) => {
  if (player.current?.song.id === songId) next()
})

// ---------- 待机音乐 ----------

/** Where the 主屏's 待机音乐 is (null: none). Other 大屏 follow it, a new 主屏 continues from it. */
let idleSync: IdleSync | null = null

export function latestIdle(): IdleSync | null {
  return idleSync
}

/** Idle-music report from the 主屏. */
export function idleReport(songId: number | null, position: number, playing: boolean, at?: number): void {
  const t = at !== undefined && Math.abs(at - serverNow()) < 5000 ? at : serverNow()
  idleSync = songId === null ? null : { songId, position: Math.max(0, position), at: t, playing }
  hub.emit('idle', idleSync)
}

/**
 * The 主屏 changed or went away: hold the idle music where it was, so the other 大屏 stop with it
 * and the next 主屏 picks it up from there.
 */
export function freezeIdle(): void {
  const s = idleSync
  if (!s || !s.playing) return
  const now = serverNow()
  idleSync = { ...s, playing: false, position: s.position + Math.max(0, now - s.at) / 1000, at: now }
  hub.emit('idle', idleSync)
}

// ---------- nobody is playing ----------

/** Where the song is right now (seconds; extrapolated while playing), as remotes compute it. */
function livePosition(now = Date.now()): number {
  return player.playing ? player.position + (now - player.positionAt) / 1000 : player.position
}

/**
 * Nothing plays the current song any more: pause it where it was (never past its end). The
 * play/pause state otherwise only changes on a TV report, so a TV that closed, reloaded (and is
 * waiting for its click) or went silent left `playing` set, and remotes kept counting past the
 * end of a song that never ended. The TV, if it is still playing, overrides this with its next
 * report; a TV that comes back resumes paused where the song was.
 */
function freeze(): void {
  const cur = player.current
  if (!cur || !player.playing) return
  const duration = cur.song.duration / 1000
  const position = Math.max(0, Math.min(duration > 0 ? duration : Infinity, livePosition()))
  player = { ...player, playing: false, position, positionAt: Date.now() }
  lastSync = { uid: cur.uid, epoch: player.epoch, position, at: serverNow(), playing: false }
  hub.emit('sync', lastSync)
  emitPlayer()
}

/** The active TV went away and no other TV is left. */
export function tvGone(): void {
  freeze()
}

/** An active TV that has not reported for this long is not playing (page reloaded, tab frozen…). */
const SILENCE_MS = 6000

setInterval(() => {
  const cur = player.current
  if (!cur || !player.playing) return
  if (hub.tvOnline) {
    if (Date.now() - lastReportAt > SILENCE_MS) freeze()
  } else if (livePosition() >= cur.song.duration / 1000) {
    // With no TV the server stands in for one (remotes still play / pause): only as far as the end.
    freeze()
  }
}, 2000).unref()
