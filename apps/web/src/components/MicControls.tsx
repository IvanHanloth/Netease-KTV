import clsx from 'clsx'
import type { PlayerCommand } from '@shared/types'
import { useLiveValue } from '../lib/hooks'
import { sendCommand, useApp } from '../store/app'
import { Range, Switch } from './ui'

/**
 * 主屏 microphone from the phone remote: on / off, level and reverb (shared player values, live).
 * Which input devices it uses is chosen on the 大屏 or the 点歌台 控制台.
 */
export function MicControls({ send = sendCommand }: { send?: (c: PlayerCommand) => unknown }) {
  const on = useApp((s) => s.state.player.micOn)
  const tvOnline = useApp((s) => s.state.tvOnline)
  const [level, setLevel] = useLiveValue(useApp((s) => Math.round(s.state.player.micVolume * 100)), (v) => ({ action: 'set', micVolume: v / 100 }), send)
  const [reverb, setReverb] = useLiveValue(useApp((s) => Math.round(s.state.player.reverb * 100)), (v) => ({ action: 'set', reverb: v / 100 }), send)
  return (
    <section aria-label="麦克风" className="flex flex-col gap-4 rounded-[20px] bg-white/4 px-4 py-3.5">
      <div className="flex items-center gap-3">
        <span className="flex-1 text-[15px] font-semibold">
          麦克风
          {!tvOnline && <span className="ml-2 text-xs font-normal text-muted">大屏未打开</span>}
        </span>
        <Switch checked={on} onChange={(v) => send({ action: 'set', micOn: v })} label="麦克风开关" />
      </div>
      <div className={clsx('flex flex-col gap-4 transition-opacity', !on && 'opacity-50')}>
        <Slider label="音量" value={level} onChange={setLevel} />
        <Slider label="混响" value={reverb} onChange={setReverb} />
      </div>
    </section>
  )
}

function Slider({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <div className="flex items-center gap-3.5">
      <span className="w-9 shrink-0 text-sm text-fg-2">{label}</span>
      <div className="min-w-0 flex-1">
        <Range label={'麦克风' + label} value={value} onChange={onChange} />
      </div>
      <span className="num w-10 shrink-0 text-right text-[13px] text-muted">{value}%</span>
    </div>
  )
}
