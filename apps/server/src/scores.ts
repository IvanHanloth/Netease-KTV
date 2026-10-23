import { getDb } from './db.js'
import { hub } from './core/hub.js'
import { getCachedSong, getSongs } from './ncm/service.js'
import type { ScoreEntry, ScoreSubmit, ScoreSubmitResult, Song, SongRanking } from './shared/types.js'

interface Row {
  id: number
  song_id: number
  score: number
  singer: string | null
  tolerance: number
  at: number
}

const toEntry = (r: Row): ScoreEntry => ({
  id: r.id,
  songId: r.song_id,
  score: Math.round(r.score * 10) / 10,
  singer: r.singer ?? undefined,
  tolerance: r.tolerance,
  at: r.at,
})

const round1 = (n: number) => Math.round(n * 10) / 10

/** Store one scored performance and tell clients the leaderboard changed. */
export function addScore(input: ScoreSubmit): ScoreSubmitResult {
  const db = getDb()
  const score = Math.max(0, Math.min(100, input.score))
  const singer = input.singer?.trim().slice(0, 24) || null
  const res = db
    .prepare('INSERT INTO scores (song_id, score, singer, tolerance, at) VALUES (?, ?, ?, ?, ?)')
    .run(input.songId, score, singer, input.tolerance, Date.now())
  const id = Number(res.lastInsertRowid)
  const row = db.prepare('SELECT * FROM scores WHERE id = ?').get(id) as unknown as Row
  const stats = db
    .prepare('SELECT COUNT(*) AS plays, MAX(score) AS best FROM scores WHERE song_id = ?')
    .get(input.songId) as { plays: number; best: number }
  const better = db
    .prepare('SELECT COUNT(*) AS n FROM scores WHERE song_id = ? AND score > ?')
    .get(input.songId, score) as { n: number }
  hub.broadcast({ type: 'scores' })
  return { entry: toEntry(row), rank: better.n + 1, plays: stats.plays, best: round1(stats.best) }
}

function entriesFor(songId: number, limit: number): ScoreEntry[] {
  const rows = getDb()
    .prepare('SELECT * FROM scores WHERE song_id = ? ORDER BY score DESC, at ASC LIMIT ?')
    .all(songId, limit) as unknown as Row[]
  return rows.map(toEntry)
}

/** Every song that has been scored, best first. */
export async function leaderboard(): Promise<SongRanking[]> {
  const stats = getDb()
    .prepare(
      `SELECT song_id, MAX(score) AS best, AVG(score) AS average, COUNT(*) AS plays
       FROM scores GROUP BY song_id ORDER BY best DESC, plays DESC`,
    )
    .all() as { song_id: number; best: number; average: number; plays: number }[]
  if (!stats.length) return []
  const songs = new Map<number, Song>()
  const missing: number[] = []
  for (const s of stats) {
    const cached = getCachedSong(s.song_id)
    if (cached) songs.set(s.song_id, cached)
    else missing.push(s.song_id)
  }
  if (missing.length) {
    try {
      for (const s of await getSongs(missing)) songs.set(s.id, s)
    } catch {
      // song details unavailable (offline / not logged in): skip those rows
    }
  }
  const shown = stats.filter((s) => songs.has(s.song_id))
  // The top 10 of every song in one query instead of one per song.
  const rows = getDb()
    .prepare(
      `SELECT * FROM (
         SELECT s.*, ROW_NUMBER() OVER (PARTITION BY song_id ORDER BY score DESC, at ASC) AS rn
         FROM scores s WHERE song_id IN (SELECT value FROM json_each(?))
       ) WHERE rn <= 10 ORDER BY song_id, rn`,
    )
    .all(JSON.stringify(shown.map((s) => s.song_id))) as unknown as Row[]
  const entries = new Map<number, ScoreEntry[]>()
  for (const r of rows) {
    const list = entries.get(r.song_id) ?? []
    list.push(toEntry(r))
    entries.set(r.song_id, list)
  }
  return shown.map((s) => ({
    song: songs.get(s.song_id)!,
    best: round1(s.best),
    average: round1(s.average),
    plays: s.plays,
    entries: entries.get(s.song_id) ?? [],
  }))
}

export async function songRanking(songId: number): Promise<SongRanking | null> {
  const s = getDb()
    .prepare('SELECT MAX(score) AS best, AVG(score) AS average, COUNT(*) AS plays FROM scores WHERE song_id = ?')
    .get(songId) as { best: number | null; average: number | null; plays: number }
  if (!s.plays) return null
  const song = getCachedSong(songId) ?? (await getSongs([songId]))[0]
  if (!song) return null
  return { song, best: round1(s.best ?? 0), average: round1(s.average ?? 0), plays: s.plays, entries: entriesFor(songId, 50) }
}

/** Reset the whole leaderboard, or one song's scores. */
export function resetScores(songId?: number): number {
  const db = getDb()
  const res = songId === undefined ? db.prepare('DELETE FROM scores').run() : db.prepare('DELETE FROM scores WHERE song_id = ?').run(songId)
  hub.broadcast({ type: 'scores' })
  return Number(res.changes)
}
