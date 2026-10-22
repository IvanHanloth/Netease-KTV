import { getDb } from '../db.js'
import type { Account, Lyrics, PlaylistSummary, QrStatus, Song } from '../shared/types.js'
import { call, clearCookie, getCookie, NcmError, setCookie } from './client.js'
import { buildLyrics } from './lyrics.js'
import { mapPlaylist, mapSongs } from './mappers.js'

/** NetEase "热歌榜" playlist id, used as the recommend list when logged out. */
const HOT_TOPLIST_ID = 3778678
const SONG_TTL = 12 * 60 * 60 * 1000

// ---------- account ----------

let accountCache: { at: number; account: Account } | null = null

export async function getAccount(force = false): Promise<Account> {
  if (!getCookie()) return { loggedIn: false }
  if (!force && accountCache && Date.now() - accountCache.at < 60_000) return accountCache.account
  try {
    const res = await call('login_status')
    const data = res.body?.data ?? res.body
    const profile = data?.profile
    const account: Account = profile
      ? {
          loggedIn: true,
          userId: Number(profile.userId),
          nickname: String(profile.nickname ?? ''),
          avatarUrl: String(profile.avatarUrl ?? ''),
          vipType: Number(profile.vipType ?? data?.account?.vipType ?? 0),
        }
      : { loggedIn: false }
    accountCache = { at: Date.now(), account }
    return account
  } catch {
    return { loggedIn: false }
  }
}

export async function createQr(): Promise<{ key: string; qrUrl: string }> {
  const keyRes = await call('login_qr_key')
  const key = String(keyRes.body?.data?.unikey ?? '')
  if (!key) throw new NcmError('无法获取登录二维码')
  const qrRes = await call('login_qr_create', { key })
  return { key, qrUrl: String(qrRes.body?.data?.qrurl ?? `https://music.163.com/login?codekey=${key}`) }
}

export async function checkQr(key: string): Promise<{ status: QrStatus; account?: Account }> {
  let res
  try {
    res = await call('login_qr_check', { key, noCookie: true })
  } catch {
    return { status: 'waiting' }
  }
  const code = Number(res.body?.code)
  if (code === 800) return { status: 'expired' }
  if (code === 802) return { status: 'scanned' }
  if (code === 803) {
    const cookie = String(res.body?.cookie ?? res.cookie?.join(';') ?? '')
    if (cookie) setCookie(cookie)
    accountCache = null
    return { status: 'ok', account: await getAccount(true) }
  }
  return { status: 'waiting' }
}

export async function loginWithCookie(cookie: string): Promise<Account> {
  const value = cookie.includes('MUSIC_U=') ? cookie : `MUSIC_U=${cookie.trim()}`
  setCookie(value)
  accountCache = null
  const account = await getAccount(true)
  if (!account.loggedIn) {
    clearCookie()
    throw new NcmError('Cookie 无效或已过期', 400)
  }
  return account
}

export async function logout(): Promise<void> {
  try {
    await call('logout')
  } catch {
    // ignore
  }
  clearCookie()
  accountCache = null
}

// ---------- songs ----------

function cacheSongs(songs: Song[]): void {
  const stmt = getDb().prepare(
    'INSERT INTO songs (id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at',
  )
  const now = Date.now()
  for (const s of songs) stmt.run(s.id, JSON.stringify(s), now)
}

export function getCachedSong(id: number): Song | undefined {
  const row = getDb().prepare('SELECT data FROM songs WHERE id = ?').get(id) as { data: string } | undefined
  return row ? (JSON.parse(row.data) as Song) : undefined
}

export async function getSongs(ids: number[], fresh = false): Promise<Song[]> {
  const result = new Map<number, Song>()
  const missing: number[] = []
  const db = getDb()
  for (const id of ids) {
    const row = db.prepare('SELECT data, updated_at FROM songs WHERE id = ?').get(id) as
      | { data: string; updated_at: number }
      | undefined
    if (row && !fresh && Date.now() - row.updated_at < SONG_TTL) result.set(id, JSON.parse(row.data))
    else missing.push(id)
  }
  for (let i = 0; i < missing.length; i += 500) {
    const chunk = missing.slice(i, i + 500)
    const res = await call('song_detail', { ids: chunk.join(',') })
    const songs = mapSongs(res.body?.songs, res.body?.privileges)
    cacheSongs(songs)
    for (const s of songs) result.set(s.id, s)
  }
  return ids.map((id) => result.get(id)).filter((s): s is Song => !!s)
}

export async function getSong(id: number, fresh = false): Promise<Song> {
  const [song] = await getSongs([id], fresh)
  if (!song) throw new NcmError('歌曲不存在', 404)
  return song
}

export async function search(q: string, offset = 0, limit = 30): Promise<{ songs: Song[]; hasMore: boolean }> {
  const res = await call('cloudsearch', { keywords: q, type: 1, limit, offset })
  const result = res.body?.result ?? {}
  const songs = mapSongs(result.songs, result.privileges)
  cacheSongs(songs)
  const total = Number(result.songCount ?? 0)
  return { songs, hasMore: offset + songs.length < total }
}

export async function suggest(q: string): Promise<string[]> {
  try {
    const res = await call('search_suggest', { keywords: q, type: 'mobile' })
    const all = (res.body?.result?.allMatch ?? []) as { keyword?: string }[]
    return all.map((x) => String(x.keyword ?? '')).filter(Boolean).slice(0, 8)
  } catch {
    return []
  }
}

export async function playlistTracks(id: number, offset = 0, limit = 100): Promise<{ songs: Song[]; hasMore: boolean }> {
  const res = await call('playlist_track_all', { id, limit, offset })
  const songs = mapSongs(res.body?.songs, res.body?.privileges)
  cacheSongs(songs)
  return { songs, hasMore: songs.length >= limit }
}

export async function recommend(): Promise<{ songs: Song[]; daily: boolean }> {
  const account = await getAccount()
  if (account.loggedIn) {
    try {
      const res = await call('recommend_songs')
      const data = res.body?.data ?? {}
      const songs = mapSongs(data.dailySongs, data.privileges)
      if (songs.length) {
        cacheSongs(songs)
        return { songs, daily: true }
      }
    } catch {
      // fall through to the hot list
    }
  }
  const { songs } = await playlistTracks(HOT_TOPLIST_ID, 0, 50)
  return { songs, daily: false }
}

export async function userPlaylists(): Promise<PlaylistSummary[]> {
  const account = await getAccount()
  if (!account.loggedIn || !account.userId) return []
  const res = await call('user_playlist', { uid: account.userId, limit: 100 })
  return ((res.body?.playlist ?? []) as any[]).map(mapPlaylist)
}

export async function toplists(): Promise<PlaylistSummary[]> {
  const res = await call('toplist')
  return ((res.body?.list ?? []) as any[]).map(mapPlaylist)
}

export async function lyrics(id: number): Promise<Lyrics> {
  const res = await call('lyric_new', { id })
  return buildLyrics(res.body)
}

export async function mvUrl(mvId: number): Promise<string> {
  const res = await call('mv_url', { id: mvId, r: 1080 })
  const url = res.body?.data?.url
  if (!url) throw new NcmError('MV 暂不可用', 404)
  return String(url)
}
