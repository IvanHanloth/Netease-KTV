import type { ClientRole, DataCacheKind, DisplayMode, MediaCacheKind, MvResolution, QueuePosition, SoundLevel, Song, Stem, TrackMode } from './types.js'

/**
 * Runtime values shared by server and web (types.ts holds only types). No Node APIs here: the
 * web bundle imports this file through the @shared alias.
 */

export const MEDIA_CACHE_KINDS: readonly MediaCacheKind[] = ['original', 'stems', 'pitched', 'analysis', 'mv', 'temp']
export const DATA_CACHE_KINDS: readonly DataCacheKind[] = ['search', 'library', 'recommend', 'lyrics', 'songs']

export const SOUND_LEVELS = ['standard', 'higher', 'exhigh', 'lossless', 'hires'] as const satisfies readonly SoundLevel[]
export const MV_RESOLUTIONS = [480, 720, 1080] as const satisfies readonly MvResolution[]
export const TRACK_MODES = ['karaoke', 'original'] as const satisfies readonly TrackMode[]
export const DISPLAY_MODES = ['stage', 'mv'] as const satisfies readonly DisplayMode[]
export const QUEUE_POSITIONS = ['end', 'next'] as const satisfies readonly QueuePosition[]
export const STEMS = ['instrumental', 'vocals', 'original'] as const satisfies readonly Stem[]
export const CLIENT_ROLES = ['tv', 'desk', 'remote', 'admin', 'ear'] as const satisfies readonly ClientRole[]

/** Key shift (升降调), semitones. */
export const KEY_MIN = -6
export const KEY_MAX = 6

/** Bounds of numeric settings (server validation and the web controls). */
export const SETTING_LIMITS = {
  cacheLimitGB: { min: 1, max: 500 },
  scoreTolerance: { min: 0.3, max: 3 },
  idleVolume: { min: 0, max: 1 },
  idleSongs: { max: 100 },
} as const

/** The requester shown when nobody set a nickname. */
export const ANONYMOUS = '匿名'

/** A nickname worth showing (not the anonymous default). */
export const singerName = (addedBy?: string) => (addedBy && addedBy !== ANONYMOUS ? addedBy : undefined)

/**
 * Why a song can't be queued, or null when it can. VIP songs never play in full; songs NetEase
 * has no source for only play when third-party sources (unblock) are switched on.
 */
export function enqueueBlockReason(song: Pick<Song, 'playable'>, unblockEnabled: boolean): string | null {
  if (song.playable === 'vip') return '需要会员才能播放完整歌曲'
  if (song.playable === 'no-source' && !unblockEnabled) return '网易云暂无音源（可在后台管理中开启第三方音源）'
  return null
}
