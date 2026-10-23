import { cached, DAY, HOUR, MIN } from '../apiCache.js'
import { getDb, stmt } from '../db.js'
import { singleFlight, TtlCache } from '../util.js'
import type { Account, AlbumDetail, ArtistDetail, Lyrics, PlaylistSummary, QrStatus, Song } from '../shared/types.js'
import { call, clearCookie, getCookie, NcmError, setCookie } from './client.js'
import { buildLyrics } from './lyrics.js'
import { mapPlaylist, mapSongs } from './mappers.js'

/** NetEase "热歌榜" playlist id, used as the recommend list when logged out. */
const HOT_TOPLIST_ID = 3778678
const SONG_TTL = 12 * 60 * 60 * 1000

// ---------- account ----------

let accountCache: { at: number; account: Account } | null = null
const accountFlight = singleFlight<'account', Account>()

export async function getAccount(force = false): Promise<Account> {
  if (!getCookie()) return { loggedIn: false }
  if (!force && accountCache && Date.now() - accountCache.at < 60_000) return accountCache.account
  return accountFlight('account', async () => {
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
      // A NetEase hiccup: keep the last known account instead of flipping everything to logged out.
      return accountCache?.account ?? { loggedIn: false }
    }
  })
}

/** Logged in, out, or as someone else: what depends on the account is stale now. */
function accountChanged(): void {
  accountCache = null
  clearLinks()
  // Playability (VIP, trial clips) is part of the song details.
  getDb().prepare('UPDATE songs SET updated_at = 0').run()
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
    accountChanged()
    return { status: 'ok', account: await getAccount(true) }
  }
  return { status: 'waiting' }
}

export async function loginWithCookie(cookie: string): Promise<Account> {
  const value = cookie.includes('MUSIC_U=') ? cookie : `MUSIC_U=${cookie.trim()}`
  setCookie(value)
  accountChanged()
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
  accountChanged()
}

// ---------- songs ----------

function cacheSongs(songs: Song[]): void {
  const upsert = stmt(
    'INSERT INTO songs (id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at',
  )
  const now = Date.now()
  for (const s of songs) upsert.run(s.id, JSON.stringify(s), now)
}

export function getCachedSong(id: number): Song | undefined {
  const row = stmt('SELECT data FROM songs WHERE id = ?').get(id) as { data: string } | undefined
  return row ? (JSON.parse(row.data) as Song) : undefined
}

async function fetchSongs(ids: number[]): Promise<Song[]> {
  const out: Song[] = []
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500)
    const res = await call('song_detail', { ids: chunk.join(',') })
    const songs = mapSongs(res.body?.songs, res.body?.privileges)
    cacheSongs(songs)
    out.push(...songs)
  }
  return out
}

/** Songs whose stale details are being refreshed in the background. */
const refreshing = new Set<number>()

/**
 * Song details in the order of `ids` (unknown ids are left out). Details older than SONG_TTL are
 * returned as they are and refreshed in the background; `fresh` waits for NetEase instead (where
 * playability must be current, e.g. before queueing).
 */
export async function getSongs(ids: number[], fresh = false): Promise<Song[]> {
  const result = new Map<number, Song>()
  const missing: number[] = []
  const stale: number[] = []
  const rows = (
    ids.length
      ? stmt('SELECT id, data, updated_at FROM songs WHERE id IN (SELECT value FROM json_each(?))').all(JSON.stringify(ids))
      : []
  ) as { id: number; data: string; updated_at: number }[]
  const byId = new Map(rows.map((r) => [Number(r.id), r]))
  const now = Date.now()
  for (const id of new Set(ids)) {
    const row = byId.get(id)
    if (!row || fresh) {
      missing.push(id)
      continue
    }
    result.set(id, JSON.parse(row.data) as Song)
    if (now - row.updated_at >= SONG_TTL && !refreshing.has(id)) stale.push(id)
  }
  if (stale.length) {
    for (const id of stale) refreshing.add(id)
    void fetchSongs(stale)
      .catch(() => {})
      .finally(() => {
        for (const id of stale) refreshing.delete(id)
      })
  }
  if (missing.length) for (const s of await fetchSongs(missing)) result.set(s.id, s)
  return ids.map((id) => result.get(id)).filter((s): s is Song => !!s)
}

export async function getSong(id: number, fresh = false): Promise<Song> {
  const [song] = await getSongs([id], fresh)
  if (!song) throw new NcmError('歌曲不存在', 404)
  return song
}

/** Cache-key scope: playability (VIP), daily picks and own playlists depend on the account. */
async function who(): Promise<string> {
  const account = await getAccount()
  return account.loggedIn && account.userId ? `u${account.userId}` : 'anon'
}

export async function search(q: string, offset = 0, limit = 30): Promise<{ songs: Song[]; hasMore: boolean }> {
  const key = `search:${await who()}:${q.trim().toLowerCase()}:${offset}:${limit}`
  return cached(key, 10 * MIN, async () => {
    const res = await call('cloudsearch', { keywords: q, type: 1, limit, offset })
    const result = res.body?.result ?? {}
    const songs = mapSongs(result.songs, result.privileges)
    cacheSongs(songs)
    const total = Number(result.songCount ?? 0)
    return { songs, hasMore: offset + songs.length < total }
  })
}

export async function suggest(q: string): Promise<string[]> {
  try {
    return await cached(`suggest:${q.trim().toLowerCase()}`, 30 * MIN, async () => {
      const res = await call('search_suggest', { keywords: q, type: 'mobile' })
      const all = (res.body?.result?.allMatch ?? []) as { keyword?: string }[]
      return all.map((x) => String(x.keyword ?? '')).filter(Boolean).slice(0, 8)
    })
  } catch {
    return []
  }
}

export async function playlistTracks(id: number, offset = 0, limit = 100): Promise<{ songs: Song[]; hasMore: boolean }> {
  return cached(`playlist:${await who()}:${id}:${offset}:${limit}`, 30 * MIN, async () => {
    const res = await call('playlist_track_all', { id, limit, offset })
    const songs = mapSongs(res.body?.songs, res.body?.privileges)
    cacheSongs(songs)
    return { songs, hasMore: songs.length >= limit }
  })
}

export async function albumDetail(id: number): Promise<AlbumDetail> {
  return cached(`album:${await who()}:${id}`, DAY, async () => {
    const res = await call('album', { id })
    const al = res.body?.album
    if (!al) throw new NcmError('专辑不存在', 404)
    const picUrl = String(al.picUrl ?? '')
    const songs = mapSongs(res.body?.songs).map((s) => ({ ...s, album: { ...s.album, picUrl: s.album.picUrl || picUrl } }))
    cacheSongs(songs)
    return {
      id,
      name: String(al.name ?? ''),
      picUrl,
      artists: (al.artists?.length ? al.artists : al.artist ? [al.artist] : []).map((a: any) => ({
        id: Number(a.id) || 0,
        name: String(a.name ?? ''),
      })),
      publishTime: Number(al.publishTime ?? 0),
      company: al.company || undefined,
      description: al.description || undefined,
      songs,
    }
  })
}

export async function artistDetail(id: number): Promise<ArtistDetail> {
  return cached(`artist:${id}`, DAY, async () => {
    const res = await call('artists', { id })
    const ar = res.body?.artist
    if (!ar) throw new NcmError('歌手不存在', 404)
    return {
      id,
      name: String(ar.name ?? ''),
      picUrl: String(ar.img1v1Url || ar.picUrl || ''),
      alias: (ar.alias ?? []).map(String),
      songCount: Number(ar.musicSize ?? 0),
      albumCount: Number(ar.albumSize ?? 0),
    }
  })
}

/** An artist's songs, most popular first. */
export async function artistSongs(id: number, offset = 0, limit = 50): Promise<{ songs: Song[]; hasMore: boolean }> {
  return cached(`artistSongs:${await who()}:${id}:${offset}:${limit}`, 6 * HOUR, async () => {
    const res = await call('artist_songs', { id, order: 'hot', offset, limit })
    const songs = mapSongs(res.body?.songs)
    cacheSongs(songs)
    return { songs, hasMore: !!res.body?.more }
  })
}

/** Pull a playlist id out of a NetEase link, share text, or a bare id. */
function playlistIdFrom(text: string): number | null {
  const m =
    /playlist[^\d]{0,40}?[?&#]id=(\d{3,})/i.exec(text) ??
    /\/playlist\/(\d{3,})/i.exec(text) ??
    /[?&]id=(\d{3,})/.exec(text) ??
    /^\s*(\d{3,})\s*$/.exec(text)
  return m ? Number(m[1]) : null
}

/**
 * Resolve whatever the user pasted (playlist URL, "分享歌单" text with a 163cn.tv short link,
 * or a playlist id) to a playlist summary. Used for temporary per-device playlist imports.
 */
export async function resolvePlaylist(text: string): Promise<PlaylistSummary> {
  let id = playlistIdFrom(text)
  if (!id) {
    const short = /https?:\/\/(?:163cn\.tv|y\.music\.163\.com|music\.163\.com)\/[^\s"'<>]+/i.exec(text)?.[0]
    if (short) {
      let url = short
      // Follow up to 5 redirects by hand to read the final location.
      for (let i = 0; i < 5 && !id; i++) {
        const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(8000) })
        const loc = res.headers.get('location')
        id = playlistIdFrom(loc ?? url)
        if (!loc) break
        url = new URL(loc, url).toString()
      }
    }
  }
  if (!id) throw new NcmError('没有识别出歌单，请粘贴网易云歌单链接或歌单 ID', 400)
  const pid = id
  const pl = await cached(`playlistDetail:${await who()}:${pid}`, DAY, async () => {
    const res = await call('playlist_detail', { id: pid })
    const raw = res.body?.playlist
    if (!raw) throw new NcmError('歌单不存在或无法访问', 404)
    return mapPlaylist(raw)
  })
  return (await withCovers([pl]))[0]!
}

export async function recommend(): Promise<{ songs: Song[]; daily: boolean }> {
  const account = await getAccount()
  if (account.loggedIn) {
    try {
      // Daily picks change once a day: key by date as well.
      const day = new Date().toISOString().slice(0, 10)
      const songs = await cached(`daily:${await who()}:${day}`, 2 * HOUR, async () => {
        const res = await call('recommend_songs')
        const data = res.body?.data ?? {}
        const list = mapSongs(data.dailySongs, data.privileges)
        if (!list.length) throw new NcmError('日推为空')
        cacheSongs(list)
        return list
      })
      return { songs, daily: true }
    } catch {
      // fall through to the hot list
    }
  }
  const { songs } = await playlistTracks(HOT_TOPLIST_ID, 0, 50)
  return { songs, daily: false }
}

/**
 * Playlists without a cover get the album cover of their first song, the way the NetEase app
 * shows them.
 */
async function withCovers(list: PlaylistSummary[]): Promise<PlaylistSummary[]> {
  return Promise.all(
    list.map(async (p) => {
      if (p.coverUrl || !p.trackCount) return p
      try {
        const { songs } = await playlistTracks(p.id, 0, 1)
        return { ...p, coverUrl: songs[0]?.album.picUrl ?? '' }
      } catch {
        return p
      }
    }),
  )
}

export async function userPlaylists(): Promise<PlaylistSummary[]> {
  const account = await getAccount()
  if (!account.loggedIn || !account.userId) return []
  const list = await cached(`userPlaylists:${await who()}`, 10 * MIN, async () => {
    const res = await call('user_playlist', { uid: account.userId, limit: 100 })
    return ((res.body?.playlist ?? []) as any[]).map(mapPlaylist)
  })
  return withCovers(list)
}

export async function toplists(): Promise<PlaylistSummary[]> {
  const list = await cached('toplists', 6 * HOUR, async () => {
    const res = await call('toplist')
    return ((res.body?.list ?? []) as any[]).map(mapPlaylist)
  })
  return withCovers(list)
}

export async function lyrics(id: number): Promise<Lyrics> {
  // Lyrics practically never change.
  return cached(`lyrics:${id}`, 7 * DAY, async () => {
    const res = await call('lyric_new', { id })
    return buildLyrics(res.body)
  })
}

/** MVs NetEase recently said it has no stream for (so the TV stops asking for a while). */
const unavailableMvs = new TtlCache<number, true>(10 * MIN, 500)

export async function mvUrl(mvId: number, resolution = 1080): Promise<string> {
  const res = await call('mv_url', { id: mvId, r: resolution })
  const url = res.body?.data?.url
  if (!url) {
    unavailableMvs.set(mvId, true)
    throw new NcmError('MV 暂不可用', 404)
  }
  unavailableMvs.delete(mvId)
  return String(url)
}

export function mvUnavailable(mvId: number): boolean {
  return !!unavailableMvs.get(mvId)
}

/**
 * Low-quality URL for a local "试听" preview on the requesting device. Only what NetEase itself
 * returns for this account (a full song or NetEase's own trial clip) — never third-party sources.
 */
export async function previewUrl(songId: number): Promise<string> {
  const res = await call('song_url_v1', { id: songId, level: 'standard' })
  const url = res.body?.data?.[0]?.url
  if (!url) throw new NcmError('暂无试听', 404)
  return String(url)
}

// ---------- signed stream links ----------

/**
 * NetEase stream URLs (MV, 试听) are signed and expire, so they are kept for 10 minutes and shared
 * by concurrent requests. A link the upstream rejects is dropped (forgetLink) and fetched again.
 */
const links = new TtlCache<string, Promise<string>>(10 * MIN, 300)

function link(key: string, resolve: () => Promise<string>): Promise<string> {
  let p = links.get(key)
  if (!p) {
    p = resolve()
    links.set(key, p)
    p.catch(() => links.delete(key))
  }
  return p
}

export const mvLinkKey = (mvId: number, res: number) => `mv:${mvId}:${res}`
export const previewLinkKey = (songId: number) => `preview:${songId}`

export function mvStreamUrl(mvId: number, res: number): Promise<string> {
  return link(mvLinkKey(mvId, res), () => mvUrl(mvId, res))
}

export function previewStreamUrl(songId: number): Promise<string> {
  return link(previewLinkKey(songId), () => previewUrl(songId))
}

export function forgetLink(key: string): void {
  links.delete(key)
}

export function clearLinks(): void {
  links.clear()
  unavailableMvs.clear()
}
