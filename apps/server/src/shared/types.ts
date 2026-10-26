// Types shared by the server and the web app (imported by web via the `@shared` alias).
// Keep this file free of runtime imports so both sides can use it.

export type SoundLevel = 'standard' | 'higher' | 'exhigh' | 'lossless' | 'hires'

/** Whether the logged-in account can get the full song from NetEase. */
export type Playability = 'ok' | 'vip' | 'no-source'

export interface Artist {
  id: number
  name: string
}

export interface Song {
  id: number
  name: string
  alias: string[]
  artists: Artist[]
  album: { id: number; name: string; picUrl: string }
  /** Duration in ms. */
  duration: number
  /** NetEase MV id, 0 when the song has no MV. */
  mvId: number
  fee: number
  playable: Playability
}

/** GET /api/albums/:id */
export interface AlbumDetail {
  id: number
  name: string
  picUrl: string
  artists: Artist[]
  /** ms since epoch, 0 when unknown */
  publishTime: number
  company?: string
  description?: string
  songs: Song[]
}

/** GET /api/artists/:id (songs: page through GET /api/artists/:id/songs) */
export interface ArtistDetail {
  id: number
  name: string
  picUrl: string
  alias: string[]
  songCount: number
  albumCount: number
}

export interface PlaylistSummary {
  id: number
  name: string
  coverUrl: string
  trackCount: number
  description?: string
}

/** Accompaniment pipeline state for one song. */
export type TrackStatus =
  | 'idle' // nothing done yet
  | 'unavailable' // VIP-only / no source and unblock is off
  | 'downloading'
  | 'queued' // waiting for the separator
  | 'separating'
  | 'ready' // stems (or the original, when separation is unavailable) are ready
  | 'error'

export type AudioSource = 'netease' | 'unblock'

export interface TrackState {
  songId: number
  status: TrackStatus
  /** 0..1, meaningful while downloading / separating. */
  progress: number
  source?: AudioSource
  /** True when instrumental + vocals stems exist; false means only the original can play. */
  hasStems: boolean
  /** True when a reference pitch track (for scoring) exists: GET /api/media/:id/pitch. */
  hasPitch?: boolean
  message?: string
  updatedAt: number
}

export interface QueueItem {
  uid: string
  song: Song
  addedAt: number
  addedBy?: string
}

/**
 * karaoke = instrumental only (plus the lead vocal inside 领唱 segments); original = instrumental + lead vocal.
 * With stems both modes use the same two buffers, so switching is a gain change (seamless).
 */
export type TrackMode = 'karaoke' | 'original'

/** TV layout: stage = immersive lyrics page; mv = full-screen MV with two lyric lines at the bottom. */
export type DisplayMode = 'stage' | 'mv'

/** Where a requested song goes: end of the queue, or next up (插播). */
export type QueuePosition = 'end' | 'next'

export interface PlayerState {
  current: QueueItem | null
  playing: boolean
  /** Playback position in seconds, measured at `positionAt`. */
  position: number
  /** Epoch ms when `position` was measured. */
  positionAt: number
  /** 0..1 */
  musicVolume: number
  /** Unused since the 导唱 slider was removed; kept so old clients and saved state still parse. */
  vocalVolume: number
  /** Pitch shift in semitones, -6..6. */
  key: number
  trackMode: TrackMode
  displayMode: DisplayMode
  /**
   * 领唱: in karaoke mode, the first line of the song and the first line after every
   * interlude are sung with the original lead vocal, then it drops back to the accompaniment.
   */
  leadVocal: boolean
  /** Bumped every time the current song restarts so the TV can reload. */
  epoch: number
  /** 待机音乐 level (0..1), its own volume: set live from the TV, remotes and the 点歌台. */
  idleVolume: number
  /** 主屏 microphone level through the speakers (0..1, 0.7 ≈ unity gain). */
  micVolume: number
  /** Microphone reverb amount (0 = dry … 1 = very wet). */
  reverb: number
  /** The 主屏 microphone is switched on (which input devices it uses is set on that 大屏). */
  micOn: boolean
}

export interface SeparatorStatus {
  online: boolean
  /** False while the separator is still downloading / loading its model (first start). */
  ready?: boolean
  device?: string
  model?: string
  pending: number
  /** Enabled separator servers, and how many of them are reachable. */
  nodes?: number
  onlineNodes?: number
}

/** One separator server as shown in 后台管理 (GET /api/admin/separators). */
export interface SeparatorNodeView {
  id: string
  name: string
  url: string
  enabled: boolean
  hasToken: boolean
  /** Model override for this node ('' = global setting / node default). */
  model: string
  /** Reachable and new enough to take jobs. */
  online: boolean
  /** Answers /health at all (may still be too old). */
  reachable: boolean
  ready: boolean
  stage?: string
  error?: string
  device?: string
  gpu: boolean
  activeModel?: string
  /** Separations waiting on / running on that node. */
  queue: number
  /** Seconds of work per second of audio (lower is faster). */
  speedFactor?: number
  /** Jobs this host has on the node right now. */
  jobs: { songId: number; songName?: string; mode: 'separate' | 'pitch' | 'align'; startedAt: number; progress: number }[]
  /** Since the KTV server started. */
  done: number
  failed: number
  lastSeen: number
}

export interface AppState {
  queue: QueueItem[]
  player: PlayerState
  tracks: Record<number, TrackState>
  separator: SeparatorStatus
  tvOnline: boolean
}

export interface LyricWord {
  /** Start time, ms. */
  t: number
  /** Duration, ms. */
  d: number
  text: string
}

export interface LyricLine {
  t: number
  d: number
  text: string
  words: LyricWord[]
  translation?: string
  roma?: string
}

export interface Lyrics {
  /** yrc = word-by-word timing, lrc = line timing (words interpolated), none = no lyrics. */
  kind: 'yrc' | 'lrc' | 'none'
  lines: LyricLine[]
  credits: string[]
}

export interface Account {
  loggedIn: boolean
  userId?: number
  nickname?: string
  avatarUrl?: string
  vipType?: number
}

export type QrStatus = 'waiting' | 'scanned' | 'expired' | 'ok'

export interface Settings {
  unblockEnabled: boolean
  unblockSources: string[]
  audioLevel: SoundLevel
  separatorModel: string
  /** LAN address used for the phone QR code, e.g. http://192.168.1.8:8686 */
  publicUrl: string
  /** Show the mic-based pitch scoring on the TV. */
  scoringEnabled: boolean
  /**
   * Pitch error (semitones) that still earns full points; credit then fades to 0 at 3×.
   * Presets: 宽松 1.5 / 标准 1.0 / 严格 0.5. Range 0.3–3.
   */
  scoreTolerance: number
  /** Download MVs of queued songs to the server ahead of time (smooth playback, enables auto-align). */
  mvPreload: boolean
  /** MV resolution to fetch / cache. */
  mvResolution: MvResolution
  /** Max disk space for cached audio, stems and MVs (GB). Oldest unused songs are evicted first. */
  cacheLimitGB: number
  /**
   * 多大屏协同: every 大屏 (TV page) shows the same 舞台 / MV mode. Off: each 大屏 other than the
   * 主屏 keeps its own mode.
   */
  multiScreenSync: boolean
  /**
   * 多大屏播放: 大屏 other than the 主屏 may unmute and play in sync with it. Turning it on unmutes
   * nothing by itself; turning it off mutes every 大屏 except the 主屏.
   */
  multiScreenAudio: boolean
  /** 待机音乐: played quietly on the TV while nothing is queued (its volume: PlayerState.idleVolume). */
  idleEnabled: boolean
  /** NetEase song ids, played in order and looped. */
  idleSongs: number[]
}

/** GET /api/idle */
export interface IdleMusic {
  enabled: boolean
  songs: Song[]
}

export type MvResolution = 480 | 720 | 1080

/** Settings the 点歌台 may change (PUT /api/settings). Everything else is ops-only (PUT /api/admin/settings). */
export type DeskSettings = Pick<Settings, 'scoringEnabled' | 'scoreTolerance' | 'multiScreenSync' | 'multiScreenAudio'>
export type AdminSettings = Omit<Settings, keyof DeskSettings>

/** GET /api/admin/status */
export interface AdminStatus {
  version: string
  node: string
  uptimeSec: number
  dataDir: string
  /** The separation cluster as a whole (per-node detail: GET /api/admin/separators). */
  separator: {
    online: boolean
    ready: boolean
    device?: string
    model?: string
    nodes: number
    onlineNodes: number
    /** Nodes separating a song for us right now. */
    busyNodes: number
    /** Queued songs still waiting for accompaniment. */
    pending: number
  }
  /** Open browser connections by page. */
  clients: { tv: number; desk: number; remote: number; admin: number; ear: number; activeTv: boolean }
  /** ACCESS_TOKEN is set. */
  authEnabled: boolean
}

/** GET /api/songs/:id/mv */
export interface MvInfo {
  mvId: number
  /** Same-origin stream URL (served from the local cache once downloaded). */
  url: string
  /** True when the MV file is fully cached on the server. */
  cached: boolean
  /** False when NetEase recently had no stream for it (and it isn't cached): don't wait for it. */
  available: boolean
  /**
   * Result of audio alignment between the MV and the song, when available:
   * videoTime = audioTime + offset (seconds). null = not aligned (yet).
   */
  offset: number | null
  /** 0..1; the TV syncs the MV to the song when this is ≥ 0.5 (or durations match). */
  confidence: number | null
}

/**
 * Kinds of cached media on disk (see apps/server/src/media/files.ts for the layout):
 * - original: downloaded song audio (re-downloaded on demand)
 * - stems: separated instrumental + vocals (re-separation takes minutes)
 * - pitched: key-shifted renders (ffmpeg, seconds; evicted first)
 * - analysis: reference pitch for scoring + MV alignment (small; recomputed when the song is queued)
 * - mv: MV videos
 * - temp: scratch files and unfinished downloads
 */
export type MediaCacheKind = 'original' | 'stems' | 'pitched' | 'analysis' | 'mv' | 'temp'

/**
 * Kinds of cached NetEase data (SQLite):
 * - search: search results and suggestions
 * - library: playlists, albums, artists, the account's playlist list
 * - recommend: daily picks and toplists
 * - lyrics
 * - songs: song details (marked stale, not deleted: the queue is restored from them)
 */
export type DataCacheKind = 'search' | 'library' | 'recommend' | 'lyrics' | 'songs'

export type CacheKind = MediaCacheKind | DataCacheKind

export interface CacheGroup {
  kind: CacheKind
  bytes: number
  /** Files (media) or rows (data). */
  count: number
  /** Part of `bytes` that clearing keeps: the current / queued songs and 待机音乐. */
  protectedBytes: number
}

/** GET /api/admin/cache */
export interface CacheInfo {
  /** Media on disk (what the limit applies to). */
  usedBytes: number
  limitBytes: number
  songs: number
  mvs: number
  media: CacheGroup[]
  data: CacheGroup[]
}

/** One song's media in the cache (GET /api/admin/cache/songs). */
export interface CachedSongInfo {
  songId: number
  name?: string
  artists?: string
  cover?: string
  bytes: number
  /** Bytes per kind (only kinds present). */
  kinds: Partial<Record<MediaCacheKind, number>>
  /** Keys with pitch-shifted renders, e.g. [-2, 1]. */
  keys: number[]
  lastUsed: number
  /** Why clearing skips it, if it does. */
  keep?: 'playing' | 'queued' | 'idle-music' | 'busy'
}

/** One finished, scored performance. */
export interface ScoreEntry {
  id: number
  songId: number
  /** 0–100, already normalized on the TV. */
  score: number
  /** Nickname of whoever requested the song (QueueItem.addedBy), if any. */
  singer?: string
  /** scoreTolerance used for this performance. */
  tolerance: number
  /** Epoch ms. */
  at: number
}

export interface SongRanking {
  song: Song
  best: number
  average: number
  plays: number
  /** Best performances first (top 10 in the list view, top 50 for a single song). */
  entries: ScoreEntry[]
}

export interface ScoreSubmit {
  songId: number
  score: number
  tolerance: number
  singer?: string
}

export interface ScoreSubmitResult {
  entry: ScoreEntry
  /** 1-based rank of this performance among all performances of the song. */
  rank: number
  plays: number
  best: number
}

/** Reference melody of the lead vocal, extracted from the vocals stem. */
export interface PitchTrack {
  /** Seconds between frames. */
  hop: number
  /** MIDI note per frame (float, e.g. 60.3); null where the lead vocal is silent / unvoiced. */
  midi: (number | null)[]
}

export type PlayerCommand =
  | { action: 'play' }
  | { action: 'pause' }
  | { action: 'toggle' }
  | { action: 'next' }
  | { action: 'restart' }
  | { action: 'seek'; position: number }
  | {
      action: 'set'
      musicVolume?: number
      vocalVolume?: number
      key?: number
      trackMode?: TrackMode
      displayMode?: DisplayMode
      leadVocal?: boolean
      idleVolume?: number
      micVolume?: number
      reverb?: number
      micOn?: boolean
    }

export type ClientRole = 'tv' | 'desk' | 'remote' | 'admin' | 'ear'

/** Messages sent by browsers over the WebSocket. */
export type ClientMessage =
  | { type: 'hello'; role: ClientRole }
  | { type: 'command'; command: PlayerCommand }
  /**
   * Sent only by the TV, ~1/s and on every state change. `at` (server clock, ms) is when the
   * sample at `position` came out of the TV's speakers; `uid` / `epoch` identify what it plays.
   */
  | { type: 'report'; position: number; playing: boolean; at?: number; uid?: string; epoch?: number; starting?: boolean }
  /** Clock sync (TV, 耳返): the server answers with `pong` right away. */
  | { type: 'ping'; id: number }
  | { type: 'ended' }
  /**
   * Sent only by the 主屏 while it is on the idle page, ~1/s and on every change: which 待机音乐
   * song it plays and where (same stamping as `report`). songId null: no idle music.
   */
  | { type: 'idleReport'; songId: number | null; position: number; playing: boolean; at?: number }
  /**
   * Sent by a TV when the user starts it ("点击开始" / "在这里播放"): it becomes the one TV that
   * plays audio, and its own 舞台 / MV mode becomes the one remotes show and control.
   */
  | { type: 'claim'; displayMode?: DisplayMode }
  /**
   * WebRTC signalling for 耳返 microphone return (the 主屏 streams its microphone mix to phones).
   * From a 耳返: to the TV `to` (or the 主屏 when omitted). From a TV: to the 耳返 `to`.
   */
  | { type: 'rtc'; to?: number; signal: RtcSignal }

/**
 * - want: a 耳返 asks for the 主屏 microphone; the TV answers with an offer or `unavailable`.
 * - offer / answer / ice: the usual WebRTC negotiation.
 * - bye: either side closed the connection.
 * - reset (server → 耳返): the 主屏 changed; ask again.
 */
export type RtcSignalKind = 'want' | 'offer' | 'answer' | 'ice' | 'bye' | 'unavailable' | 'reset'

export interface RtcSignal {
  kind: RtcSignalKind
  sdp?: string
  candidate?: { candidate: string; sdpMid?: string | null; sdpMLineIndex?: number | null; usernameFragment?: string | null } | null
}

/** Messages sent by the server over the WebSocket. */
export type ServerMessage =
  | { type: 'state'; state: AppState }
  | { type: 'queue'; queue: QueueItem[] }
  | { type: 'player'; player: PlayerState }
  | { type: 'track'; track: TrackState }
  | { type: 'separator'; separator: SeparatorStatus }
  | { type: 'tv'; online: boolean }
  /**
   * Sent to TV connections only. Exactly one TV is active (plays audio, reports position,
   * receives commands); the others must stay silent until they send `claim`.
   */
  | { type: 'tvRole'; active: boolean }
  /** The leaderboard changed (new score or reset): refetch GET /api/scores. */
  | { type: 'scores' }
  /** 点歌记录 changed. */
  | { type: 'history' }
  /** Settings changed (desk or 后台管理): refetch GET /api/settings and /api/idle. */
  | { type: 'settings' }
  /** Forwarded to the TV: play / pause / seek / restart. */
  | { type: 'command'; command: PlayerCommand }
  /** Answer to `ping`: `t` = server clock (ms, sub-millisecond precision). */
  | { type: 'pong'; id: number; t: number }
  /** To 耳返 clients: the TV's latest playback position (see PlaybackSync). */
  | { type: 'sync'; sync: PlaybackSync }
  /** To TVs: the 主屏's 待机音乐 (other 大屏 show and play the same song in step). */
  | { type: 'idle'; idle: IdleSync | null }
  /** Relayed WebRTC signalling; `from` is the sender's connection id (0 = the server). */
  | { type: 'rtc'; from: number; signal: RtcSignal }

/**
 * Where the active TV is, on the server clock: at server time `at` (ms) the TV's speakers were
 * playing `position` (s) of song `uid`. While playing, position(t) = position + (t − at) / 1000.
 */
export interface PlaybackSync {
  uid: string
  epoch: number
  position: number
  at: number
  playing: boolean
  /** The 主屏 is showing 即将开始 (the song is held at 0 until it starts): other 大屏 show it too. */
  starting?: boolean
}

/** The 主屏's 待机音乐 on the server clock: at `at` (ms) its speakers played `position` (s) of `songId`. */
export interface IdleSync {
  songId: number
  position: number
  at: number
  playing: boolean
}

export type Stem = 'instrumental' | 'vocals' | 'original'
