import type {
  Account,
  AppState,
  CacheInfo,
  Lyrics,
  MvInfo,
  PitchTrack,
  PlayerCommand,
  PlaylistSummary,
  QrStatus,
  QueueItem,
  QueuePosition,
  ScoreSubmit,
  ScoreSubmitResult,
  Settings,
  Song,
  SongRanking,
  Stem,
} from '@shared/types'

const TOKEN_KEY = 'ktv.token'

function readToken(): string | null {
  try {
    const url = new URL(window.location.href)
    const fromUrl = url.searchParams.get('token')
    if (fromUrl) {
      localStorage.setItem(TOKEN_KEY, fromUrl)
      return fromUrl
    }
    return localStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

let token: string | null = typeof window !== 'undefined' ? readToken() : null

export function getToken() {
  return token
}

export function setToken(value: string | null) {
  token = value
  try {
    if (value) localStorage.setItem(TOKEN_KEY, value)
    else localStorage.removeItem(TOKEN_KEY)
  } catch {
    /* storage unavailable */
  }
}

/** Append `?token=` to a same-origin URL when a token is set. */
export function withToken(path: string): string {
  if (!token) return path
  return path + (path.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token)
}

export class ApiError extends Error {
  /** HTTP status; 0 = network failure or timeout (no response). */
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/** Errors worth retrying: no response (network / timeout), server errors, throttling. */
export function isRetryable(e: unknown): boolean {
  if (e instanceof ApiError) return e.status === 0 || e.status >= 500 || e.status === 408 || e.status === 429
  // Anything that is not an ApiError came from fetch itself (offline, DNS, reset …).
  return e instanceof TypeError
}

/** A request that hangs longer than this becomes a retryable error instead of spinning forever. */
const TIMEOUT_MS = 12_000

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {}
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (token) headers.Authorization = 'Bearer ' + token
  const ac = new AbortController()
  const timer = window.setTimeout(() => ac.abort(), TIMEOUT_MS)
  let res: Response
  try {
    res = await fetch('/api' + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ac.signal,
    })
  } catch (e) {
    window.clearTimeout(timer)
    throw new ApiError(0, ac.signal.aborted ? '请求超时，请检查网络' : '网络连接失败，请检查网络')
  }
  window.clearTimeout(timer)
  if (!res.ok) {
    let msg = res.statusText
    try {
      const data = await res.json()
      msg = data?.message || data?.error || msg
    } catch {
      /* not json */
    }
    throw new ApiError(res.status, msg)
  }
  if (res.status === 204) return undefined as T
  const text = await res.text()
  return (text ? JSON.parse(text) : undefined) as T
}

const get = <T>(p: string) => request<T>('GET', p)
const post = <T>(p: string, b?: unknown) => request<T>('POST', p, b ?? {})
const put = <T>(p: string, b?: unknown) => request<T>('PUT', p, b ?? {})
const del = <T>(p: string) => request<T>('DELETE', p)

const q = (params: Record<string, string | number | undefined>) => {
  const s = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') s.set(k, String(v))
  const str = s.toString()
  return str ? '?' + str : ''
}

export interface SongPage {
  songs: Song[]
  hasMore: boolean
}

export type SettingsResponse = Settings & { unblockSourceOptions: string[] }

export const api = {
  health: () => get<{ ok: boolean; version?: string }>('/health'),
  state: () => get<AppState>('/state'),

  account: () => get<Account>('/account'),
  createQr: () => post<{ key: string; qrUrl: string }>('/auth/qr'),
  checkQr: (key: string) => get<{ status: QrStatus; account?: Account }>('/auth/qr/' + encodeURIComponent(key)),
  loginCookie: (cookie: string) => post<Account>('/auth/cookie', { cookie }),
  logout: () => post<void>('/auth/logout'),

  search: (keyword: string, offset = 0, limit = 30) => get<SongPage>('/search' + q({ q: keyword, offset, limit })),
  suggest: (keyword: string) => get<{ keywords: string[] }>('/search/suggest' + q({ q: keyword })),
  recommend: () => get<{ songs: Song[]; daily: boolean }>('/recommend'),
  playlists: () => get<{ playlists: PlaylistSummary[] }>('/playlists'),
  toplists: () => get<{ playlists: PlaylistSummary[] }>('/toplists'),
  playlistTracks: (id: number, offset = 0, limit = 100) =>
    get<SongPage>(`/playlists/${id}/tracks` + q({ offset, limit })),
  song: (id: number) => get<Song>('/songs/' + id),
  lyrics: (id: number) => get<Lyrics>(`/songs/${id}/lyrics`),
  mv: (id: number) => get<MvInfo>(`/songs/${id}/mv`),
  pitch: (id: number) => get<PitchTrack>(`/media/${id}/pitch`),

  enqueue: (songId: number, position: QueuePosition = 'end', addedBy?: string) =>
    post<QueueItem>('/queue', { songId, position, ...(addedBy ? { addedBy } : {}) }),
  /** Skip the current song and sing this queued one right away. */
  queueTop: (uid: string) => post<void>(`/queue/${encodeURIComponent(uid)}/top`),
  queueReorder: (uids: string[]) => post<void>('/queue/reorder', { uids }),
  queueRemove: (uid: string) => del<void>('/queue/' + encodeURIComponent(uid)),
  queueClear: () => del<void>('/queue'),
  queueShuffle: () => post<void>('/queue/shuffle'),
  resolvePlaylist: (text: string) => get<PlaylistSummary>('/playlists/resolve' + q({ q: text })),

  command: (command: PlayerCommand) => post<void>('/player/command', command),
  retryTrack: (songId: number) => post<void>(`/tracks/${songId}/retry`),

  scores: () => get<{ songs: SongRanking[] }>('/scores'),
  songScores: (songId: number) => get<SongRanking>('/scores/' + songId),
  submitScore: (body: ScoreSubmit) => post<ScoreSubmitResult>('/scores', body),
  resetScores: () => del<{ removed: number }>('/scores'),
  resetSongScores: (songId: number) => del<{ removed: number }>('/scores/' + songId),

  settings: () => get<SettingsResponse>('/settings'),
  saveSettings: (patch: Partial<Settings>) => put<SettingsResponse>('/settings', patch),

  cache: () => get<CacheInfo>('/cache'),
  clearCache: () => del<{ removed?: number }>('/cache'),
}

/** Low-quality audio for previewing a song on this device (never touches the TV / queue). */
export function previewUrl(songId: number) {
  return withToken(`/api/songs/${songId}/preview`)
}

export function mediaUrl(songId: number, stem: Stem, key = 0) {
  return withToken(`/api/media/${songId}/${stem}${key ? `?key=${key}` : ''}`)
}

export function imgUrl(picUrl: string | undefined | null, size = 300): string | undefined {
  if (!picUrl) return undefined
  return withToken(`/api/img?u=${encodeURIComponent(picUrl)}&s=${size}`)
}

export function tokenized(url: string): string {
  return url.startsWith('/') ? withToken(url) : url
}
