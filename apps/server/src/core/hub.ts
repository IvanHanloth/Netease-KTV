import { EventEmitter } from 'node:events'
import { getDb, stmt } from '../db.js'
import { hasPitch } from '../media/files.js'
import type { SeparatorStatus, ServerMessage, TrackState } from '../shared/types.js'

/** Central in-memory state + broadcast bus. WebSocket clients subscribe to 'message'. */
class Hub extends EventEmitter {
  tracks = new Map<number, TrackState>()
  private progressSent = new Map<number, number>()
  separator: SeparatorStatus = { online: false, pending: 0 }
  tvClients = 0

  get tvOnline(): boolean {
    return this.tvClients > 0
  }

  broadcast(msg: ServerMessage): void {
    this.emit('message', msg)
  }

  loadTracks(): void {
    // Idle, and work that was in progress when the server stopped (it starts over), is the same as
    // no entry at all: drop those rows so the state snapshot only carries songs that got somewhere.
    getDb().prepare("DELETE FROM tracks WHERE status IN ('idle', 'downloading', 'queued', 'separating')").run()
    const rows = getDb().prepare('SELECT * FROM tracks').all() as any[]
    for (const r of rows) {
      const status = r.status as TrackState['status']
      this.tracks.set(r.song_id, {
        songId: r.song_id,
        status,
        progress: status === 'ready' ? 1 : 0,
        source: r.source ?? undefined,
        hasStems: !!r.has_stems,
        hasPitch: hasPitch(r.song_id),
        message: r.message ?? undefined,
        updatedAt: r.updated_at,
      })
    }
  }

  getTrack(songId: number): TrackState {
    return (
      this.tracks.get(songId) ?? { songId, status: 'idle', progress: 0, hasStems: false, updatedAt: Date.now() }
    )
  }

  /** Merge a patch into a track, persist durable fields and broadcast. */
  setTrack(songId: number, patch: Partial<TrackState>, persist = true): TrackState {
    const prev = this.getTrack(songId)
    const next: TrackState = { ...prev, ...patch, songId, updatedAt: Date.now() }
    // Progress ticks (download / separation) reach clients at most twice a second per song:
    // every one re-renders the song lists on every screen.
    const progressOnly = !persist && next.status === prev.status && next.progress < 1
    if (progressOnly && next.updatedAt - (this.progressSent.get(songId) ?? 0) < 500) {
      this.tracks.set(songId, next)
      return next
    }
    this.progressSent.set(songId, next.updatedAt)
    if (next.status === 'idle') {
      // Idle is the default for any song: keep no entry (clients still hear about the change below).
      this.tracks.delete(songId)
      if (persist) stmt('DELETE FROM tracks WHERE song_id = ?').run(songId)
    } else {
      this.tracks.set(songId, next)
      if (persist) {
        stmt(
          `INSERT INTO tracks (song_id, status, source, has_stems, message, updated_at) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(song_id) DO UPDATE SET status = excluded.status, source = excluded.source,
             has_stems = excluded.has_stems, message = excluded.message, updated_at = excluded.updated_at`,
        ).run(songId, next.status, next.source ?? null, next.hasStems ? 1 : 0, next.message ?? null, next.updatedAt)
      }
    }
    this.broadcast({ type: 'track', track: next })
    return next
  }

  /** Drop a track that is back to idle with nothing on disk (absent = idle for everyone). */
  forgetTrack(songId: number): void {
    if (!this.tracks.delete(songId)) return
    getDb().prepare('DELETE FROM tracks WHERE song_id = ?').run(songId)
  }

  setSeparator(status: SeparatorStatus): void {
    const prev = this.separator
    this.separator = status
    if (
      prev.online !== status.online ||
      prev.ready !== status.ready ||
      prev.pending !== status.pending ||
      prev.model !== status.model ||
      prev.device !== status.device ||
      prev.nodes !== status.nodes ||
      prev.onlineNodes !== status.onlineNodes
    ) {
      this.broadcast({ type: 'separator', separator: status })
    }
  }

  tracksRecord(): Record<number, TrackState> {
    return Object.fromEntries(this.tracks)
  }
}

export const hub = new Hub()
hub.setMaxListeners(200)
