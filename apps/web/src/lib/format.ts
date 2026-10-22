import type { Song, TrackState } from '@shared/types'

export const artistsText = (song: Pick<Song, 'artists'>) => song.artists.map((a) => a.name).join(' / ')

export function fmtTime(sec: number) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0
  const s = Math.floor(sec)
  return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0')
}

export const fmtMs = (ms: number) => fmtTime(ms / 1000)

export type PillKind =
  | 'ready'
  | 'original'
  | 'third'
  | 'proc'
  | 'download'
  | 'queued'
  | 'new'
  | 'vip'
  | 'nosource'
  | 'error'

export interface SongStatus {
  kind: PillKind
  label: string
  progress?: number
}

const pct = (p: number) => Math.round(Math.max(0, Math.min(1, p)) * 100) + '%'

export function deriveStatus(song: Song, track: TrackState | undefined, inQueue: boolean): SongStatus {
  if (song.playable === 'vip') return { kind: 'vip', label: '需要会员' }
  switch (track?.status) {
    case 'unavailable':
      return song.playable === 'no-source' || !track.message
        ? { kind: 'nosource', label: '暂无音源' }
        : { kind: 'vip', label: track.message.slice(0, 8) }
    case 'ready':
      if (track.source === 'unblock') return { kind: 'third', label: '第三方音源' }
      if (!track.hasStems) return { kind: 'original', label: '仅原曲' }
      return { kind: 'ready', label: '已就绪' }
    case 'separating':
      return { kind: 'proc', label: '分离中 ' + pct(track.progress), progress: track.progress }
    case 'downloading':
      return { kind: 'download', label: '下载中 ' + pct(track.progress), progress: track.progress }
    case 'queued':
      return { kind: 'queued', label: '排队中' }
    case 'error':
      return { kind: 'error', label: '处理失败' }
    default:
      if (song.playable === 'no-source') return { kind: 'nosource', label: '暂无音源' }
      if (inQueue) return { kind: 'queued', label: '排队中' }
      return { kind: 'new', label: '点歌后处理' }
  }
}

/** Short status text for queue rows (artist · status). */
export function queueStatusText(s: SongStatus) {
  if (s.kind === 'queued') return '排队生成伴奏'
  return s.label
}

export const isPlayableNow = (s: SongStatus) => s.kind === 'ready' || s.kind === 'original' || s.kind === 'third'

export const canEnqueue = (song: Song) => song.playable !== 'vip'
