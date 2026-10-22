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

export type TrackMode = 'karaoke' | 'original'

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
  /** Bumped every time the current song restarts so the TV can reload. */
  epoch: number
}

export interface SeparatorStatus {
  online: boolean
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
    }

export type ClientRole = 'tv' | 'desk' | 'remote'

/** Messages sent by browsers over the WebSocket. */
export type ClientMessage =
  | { type: 'hello'; role: ClientRole }
  | { type: 'command'; command: PlayerCommand }
  /** Sent only by the TV, ~1/s and on every state change. */
  | { type: 'report'; position: number; playing: boolean }
  | { type: 'ended' }

/** Messages sent by the server over the WebSocket. */
export type ServerMessage =
  | { type: 'state'; state: AppState }
  | { type: 'queue'; queue: QueueItem[] }
  | { type: 'player'; player: PlayerState }
  | { type: 'track'; track: TrackState }
  | { type: 'separator'; separator: SeparatorStatus }
  | { type: 'tv'; online: boolean }
  /** Forwarded to the TV: play / pause / seek / restart. */
  | { type: 'command'; command: PlayerCommand }

export type Stem = 'instrumental' | 'vocals' | 'original'
