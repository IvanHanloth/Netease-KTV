import { hub } from './core/hub.js'
import { getDb, kv } from './db.js'
import * as ncm from './ncm/service.js'
import type { Song } from './shared/types.js'

/** 点歌记录: the latest distinct songs anyone queued, newest first. */
export const HISTORY_LIMIT = 50

export function recordPick(songId: number): void {
  const db = getDb()
  // A repeat pick moves the song back to the top.
  db.prepare('INSERT INTO history (song_id, at) VALUES (?, ?) ON CONFLICT(song_id) DO UPDATE SET at = excluded.at').run(
    songId,
    Date.now(),
  )
  db.prepare('DELETE FROM history WHERE song_id NOT IN (SELECT song_id FROM history ORDER BY at DESC LIMIT ?)').run(
    HISTORY_LIMIT,
  )
  hub.broadcast({ type: 'history' })
}

/**
 * One-time backfill for installs that predate 点歌记录: every song that was ever downloaded for
 * the queue has a row in `tracks`, so the most recent ones are a good stand-in.
 */
export function seedHistory(): void {
  if (kv.get<boolean>('historySeeded')) return
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO history (song_id, at)
       SELECT song_id, updated_at FROM tracks ORDER BY updated_at DESC LIMIT ?`,
    )
    .run(HISTORY_LIMIT)
  kv.set('historySeeded', true)
}

export async function listHistory(): Promise<{ songs: Song[] }> {
  const rows = getDb()
    .prepare('SELECT song_id FROM history ORDER BY at DESC LIMIT ?')
    .all(HISTORY_LIMIT) as { song_id: number }[]
  const songs = await ncm.getSongs(rows.map((r) => r.song_id))
  const byId = new Map(songs.map((s) => [s.id, s]))
  return { songs: rows.map((r) => byId.get(r.song_id)).filter((s): s is Song => !!s) }
}
