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
 * karaoke = instrumental + vocals at `vocalVolume`; original = vocals at full level.
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
  /** Lead-vocal ("导唱") volume, 0..1. */
  vocalVolume: number
  /** Pitch shift in semitones, -6..6. */
  key: number
  trackMode: TrackMode
  displayMode: DisplayMode
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
}

export type MvResolution = 480 | 720 | 1080

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
    }

export type ClientRole = 'tv' | 'desk' | 'remote'

/** Messages sent by browsers over the WebSocket. */
export type ClientMessage =
  | { type: 'hello'; role: ClientRole }
  | { type: 'command'; command: PlayerCommand }
  /** Sent only by the TV, ~1/s and on every state change. */
  | { type: 'report'; position: number; playing: boolean }
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
  /** Forwarded to the TV: play / pause / seek / restart. */
  | { type: 'command'; command: PlayerCommand }

export type Stem = 'instrumental' | 'vocals' | 'original'
