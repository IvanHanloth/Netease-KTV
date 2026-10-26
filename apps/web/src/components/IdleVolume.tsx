import type { PlayerCommand } from '@shared/types'
import { useLiveValue } from '../lib/hooks'
import { sendCommand, useApp } from '../store/app'
import { Icon } from './icons'
import { Range } from './ui'

/**
 * 待机音乐音量: the level of the idle music on every 大屏, live (like the accompaniment volume).
 * A 大屏 other than the 主屏 additionally has its own volume on top of it.
 */
export function IdleVolumeControl({ send = sendCommand, hint }: { send?: (c: PlayerCommand) => unknown; hint?: string }) {
  const remote = useApp((s) => Math.round(s.state.player.idleVolume * 100))
  const [value, setValue] = useLiveValue(remote, (v) => ({ action: 'set', idleVolume: v / 100 }), send)
  return (
    <label className="flex flex-col gap-1.5">
      <span className="flex items-center justify-between text-sm">
        <span className="flex items-center gap-2">
          <Icon name="note" size={18} />
          待机音乐音量
        </span>
        <span className="num text-[#C8C8D0]">{value}%</span>
      </span>
      <Range label="待机音乐音量" value={value} onChange={setValue} color="#8B7BFF" />
      {hint && <span className="text-xs leading-5 text-muted">{hint}</span>}
    </label>
  )
}
