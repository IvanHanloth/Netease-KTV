import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { paths } from './config.js'

let db: DatabaseSync | null = null

export function getDb(): DatabaseSync {
  if (db) return db
  const file = paths.db()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  db = new DatabaseSync(file)
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS kv (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS songs (
      id INTEGER PRIMARY KEY,
      data TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tracks (
      song_id INTEGER PRIMARY KEY,
      status TEXT NOT NULL,
      source TEXT,
      has_stems INTEGER NOT NULL DEFAULT 0,
      original TEXT,
      model TEXT,
      message TEXT,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS scores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      song_id INTEGER NOT NULL,
      score REAL NOT NULL,
      singer TEXT,
      tolerance REAL NOT NULL,
      at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS scores_song ON scores (song_id, score DESC);
    CREATE TABLE IF NOT EXISTS queue (
      uid TEXT PRIMARY KEY,
      song_id INTEGER NOT NULL,
      position INTEGER NOT NULL,
      added_at INTEGER NOT NULL,
      added_by TEXT
    );
  `)
  return db
}

export const kv = {
  get<T>(key: string): T | undefined {
    const row = getDb().prepare('SELECT value FROM kv WHERE key = ?').get(key) as
      | { value: string }
      | undefined
    if (!row) return undefined
    try {
      return JSON.parse(row.value) as T
    } catch {
      return undefined
    }
  },
  set(key: string, value: unknown): void {
    getDb()
      .prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(value))
  },
  delete(key: string): void {
    getDb().prepare('DELETE FROM kv WHERE key = ?').run(key)
  },
}
