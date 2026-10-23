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
  /** 待机音乐: played quietly on the TV while nothing is queued. */
  idleEnabled: boolean
  /** Idle-music level as a share of the accompaniment volume (0..1). */
  idleVolume: number
  /** NetEase song ids, played in order and looped. */
  idleSongs: number[]
}

/** GET /api/idle */
export interface IdleMusic {
  enabled: boolean
  volume: number
  songs: Song[]
}

export type MvResolution = 480 | 720 | 1080

/** Settings the 点歌台 may change (PUT /api/settings). Everything else is ops-only (PUT /api/admin/settings). */
export type DeskSettings = Pick<Settings, 'scoringEnabled' | 'scoreTolerance'>
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
  /**
   * Result of audio alignment between the MV and the song, when available:
   * videoTime = audioTime + offset (seconds). null = not aligned (yet).
   */
  offset: number | null
  /** 0..1; the TV syncs the MV to the song when this is ≥ 0.5 (or durations match). */
  confidence: number | null
}

/** GET /api/cache */
export interface CacheInfo {
  usedBytes: number
  limitBytes: number
  audioBytes: number
  mvBytes: number
  songs: number
  mvs: number
  /** Cached NetEase data (toplists, playlists, daily picks, search, lyrics…). */
  dataEntries: number
  dataBytes: number
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
  | { type: 'report'; position: number; playing: boolean; at?: number; uid?: string; epoch?: number }
  /** Clock sync (TV, 耳返): the server answers with `pong` right away. */
  | { type: 'ping'; id: number }
  | { type: 'ended' }
  /** Sent by a TV when the user starts it ("点击开始" / "在这里播放"): it becomes the one TV that plays audio. */
  | { type: 'claim' }

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
}

export type Stem = 'instrumental' | 'vocals' | 'original'
