import type { Song, TrackState } from '@shared/types'

export const artistsText = (song: Pick<Song, 'artists'>) => song.artists.map((a) => a.name).join(' / ')

export function fmtTime(sec: number) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0
  const s = Math.floor(sec)
  return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0')
}

export const fmtMs = (ms: number) => fmtTime(ms / 1000)

/** 1.3 GB, 950 MB, 469 KB. */
export function fmtBytes(bytes: number): string {
  const KB = 1024
  const MB = KB * 1024
  const GB = MB * 1024
  if (bytes >= GB) return `${(bytes / GB).toFixed(bytes >= 10 * GB ? 0 : 1)} GB`
  if (bytes >= MB) return `${(bytes / MB).toFixed(bytes >= 10 * MB ? 0 : 1)} MB`
  return `${Math.max(bytes > 0 ? 1 : 0, Math.round(bytes / KB))} KB`
}

/** 刚刚, 5 分钟前, 3 小时前, 2 天前, 2026-09-14. */
export function fmtAgo(at: number, now = Date.now()): string {
  const s = Math.max(0, (now - at) / 1000)
  if (s < 60) return '刚刚'
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`
  if (s < 30 * 86400) return `${Math.floor(s / 86400)} 天前`
  const d = new Date(at)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

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

/** 原调, 升 2 调, 降 1 调. */
export const keyText = (k: number) => (k === 0 ? '原调' : k > 0 ? `升 ${k} 调` : `降 ${-k} 调`)
