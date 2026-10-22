import { EventEmitter } from 'node:events'
import { getDb } from '../db.js'
import type { SeparatorStatus, ServerMessage, TrackState } from '../shared/types.js'

/** Central in-memory state + broadcast bus. WebSocket clients subscribe to 'message'. */
class Hub extends EventEmitter {
  tracks = new Map<number, TrackState>()
  separator: SeparatorStatus = { online: false, pending: 0 }
  tvClients = 0

  get tvOnline(): boolean {
    return this.tvClients > 0
  }

  broadcast(msg: ServerMessage): void {
    this.emit('message', msg)
  }

  loadTracks(): void {
    const rows = getDb().prepare('SELECT * FROM tracks').all() as any[]
    for (const r of rows) {
      let status = r.status as TrackState['status']
      // Work that was in progress when the server stopped starts over.
      if (status === 'downloading' || status === 'queued' || status === 'separating') status = 'idle'
      this.tracks.set(r.song_id, {
        songId: r.song_id,
        status,
        progress: status === 'ready' ? 1 : 0,
        source: r.source ?? undefined,
        hasStems: !!r.has_stems,
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
    const next: TrackState = { ...this.getTrack(songId), ...patch, songId, updatedAt: Date.now() }
    this.tracks.set(songId, next)
    if (persist) {
      getDb()
        .prepare(
          `INSERT INTO tracks (song_id, status, source, has_stems, message, updated_at) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(song_id) DO UPDATE SET status = excluded.status, source = excluded.source,
             has_stems = excluded.has_stems, message = excluded.message, updated_at = excluded.updated_at`,
        )
        .run(songId, next.status, next.source ?? null, next.hasStems ? 1 : 0, next.message ?? null, next.updatedAt)
    }
    this.broadcast({ type: 'track', track: next })
    return next
  }

  setSeparator(status: SeparatorStatus): void {
    const prev = this.separator
    this.separator = status
    if (
      prev.online !== status.online ||
      prev.pending !== status.pending ||
      prev.model !== status.model ||
      prev.device !== status.device
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
