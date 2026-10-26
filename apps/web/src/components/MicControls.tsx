import clsx from 'clsx'
import type { PlayerCommand } from '@shared/types'
import { useLiveValue } from '../lib/hooks'
import { sendCommand, useApp } from '../store/app'
import { Icon, type IconName } from './icons'
import { Range, Switch } from './ui'

/**
 * 主屏 microphone from a 点歌台 / remote: on / off, level and reverb (shared player values, live).
 * Which input devices it uses is chosen on the 大屏 itself.
 */
export function MicControls({ send = sendCommand }: { send?: (c: PlayerCommand) => unknown }) {
  const on = useApp((s) => s.state.player.micOn)
  const tvOnline = useApp((s) => s.state.tvOnline)
  const [level, setLevel] = useLiveValue(useApp((s) => Math.round(s.state.player.micVolume * 100)), (v) => ({ action: 'set', micVolume: v / 100 }), send)
  const [reverb, setReverb] = useLiveValue(useApp((s) => Math.round(s.state.player.reverb * 100)), (v) => ({ action: 'set', reverb: v / 100 }), send)
  return (
    <div className="flex flex-col gap-3.5">
      <div className="flex items-center gap-3">
        <span
          className={clsx(
            'flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition-colors',
            on ? 'bg-ok-dot/15 text-ok' : 'bg-white/8 text-fg-2',
          )}
        >
          <Icon name="mic" size={18} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-[15px] font-semibold">麦克风</span>
          <span className="truncate text-xs text-muted">
            {!tvOnline ? '大屏未打开' : on ? '已打开' : '已关闭'}
          </span>
        </span>
        <Switch checked={on} onChange={(v) => send({ action: 'set', micOn: v })} label="麦克风开关" />
      </div>
      <div className={clsx('grid grid-cols-2 gap-4 transition-opacity', !on && 'opacity-50')}>
        <Slider icon="volume" label="音量" value={level} onChange={setLevel} />
        <Slider icon="sparkles" label="混响" value={reverb} onChange={setReverb} />
      </div>
    </div>
  )
}

function Slider({ icon, label, value, onChange }: { icon: IconName; label: string; value: number; onChange: (v: number) => void }) {
  return (
    <label className="flex min-w-0 flex-col gap-1.5">
      <span className="flex items-center justify-between text-sm">
        <span className="flex items-center gap-1.5 text-fg-2">
          <Icon name={icon} size={16} />
          {label}
        </span>
        <span className="num text-[#C8C8D0]">{value}%</span>
      </span>
      <Range label={'麦克风' + label} value={value} onChange={onChange} />
    </label>
  )
}
