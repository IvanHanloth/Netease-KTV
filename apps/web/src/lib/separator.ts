import type { SeparatorStatus } from '@shared/types'

/**
 * One reading of the separator cluster's health, shared by the 点歌台 chip and the 后台 overview,
 * so both say the same thing.
 */
export type SeparatorPhase = 'connecting' | 'unknown' | 'unconfigured' | 'offline' | 'preparing' | 'ready'

export function separatorPhase(s: Pick<SeparatorStatus, 'online' | 'ready' | 'nodes'> | undefined, connected = true): SeparatorPhase {
  if (!connected) return 'connecting'
  // The server's status before its first poll has no node count yet.
  if (!s || s.nodes === undefined) return 'unknown'
  if (s.nodes === 0) return 'unconfigured'
  if (!s.online) return 'offline'
  if (s.ready === false) return 'preparing'
  return 'ready'
}

export const SEPARATOR_LABEL: Record<SeparatorPhase, string> = {
  connecting: '连接中',
  unknown: '读取中',
  unconfigured: '未配置',
  offline: '离线',
  preparing: '模型准备中',
  ready: '就绪',
}

export type SeparatorTone = 'ok' | 'warn' | 'bad' | 'idle'

export const SEPARATOR_TONE: Record<SeparatorPhase, SeparatorTone> = {
  connecting: 'idle',
  unknown: 'idle',
  unconfigured: 'warn',
  offline: 'bad',
  preparing: 'warn',
  ready: 'ok',
}
