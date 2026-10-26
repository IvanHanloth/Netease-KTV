import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import type { PlayerState } from '@shared/types'
import { useApp } from '../../store/app'
import type { MicError } from '../../player/mic'
import { DEFAULT_MIC } from '../../player/micMixer'
import type { MicControl } from '../../player/useMicMixer'
import { Icon } from '../../components/icons'
import { Range, Spinner, Switch } from '../../components/ui'
import { sendCommand } from '../../store/app'

const setPlayer = (patch: { micVolume?: number; reverb?: number }) => sendCommand({ action: 'set', ...patch })

/** 大屏 microphone: the control-bar button and its popover (switch, input devices, level, reverb). */

const errorText: Record<MicError, string> = {
  insecure: '需要通过 localhost 或 HTTPS 打开大屏',
  denied: '没有麦克风权限，请在浏览器地址栏里允许',
  unavailable: '无法打开：设备被占用或已拔出',
}

export function MicButton({ mic, open, onToggle }: { mic: MicControl; open: boolean; onToggle: () => void }) {
  const live = mic.on && mic.status === 'on'
  const trouble = mic.on && (mic.status === 'error' || mic.errors.size > 0)
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-haspopup="dialog"
      title="麦克风"
      className={clsx(
        'flex h-14 shrink-0 items-center gap-2 rounded-[18px] px-4 text-[15px] whitespace-nowrap transition-colors',
        live ? 'border border-ok-dot/40 bg-ok-dot/12 text-fg hover:bg-ok-dot/18' : 'glass text-fg hover:bg-white/10',
        open && !live && 'bg-white/12',
      )}
    >
      <Icon name="mic" size={20} className={clsx(!mic.on && 'opacity-60')} />
      <span className="hidden min-[1280px]:inline">麦克风</span>
      {mic.on && mic.status === 'starting' && <Spinner size={14} />}
      {live && !trouble && <span className="h-2 w-2 rounded-full bg-ok-dot" aria-label="已打开" />}
      {trouble && <span className="h-2 w-2 rounded-full bg-warn" aria-label="有问题" />}
    </button>
  )
}

/** Level meters, drawn straight into the DOM ~30×/s (no React re-render). */
function useMeters(mic: MicControl) {
  const bars = useRef(new Map<string, HTMLSpanElement>())
  const levels = mic.levels
  useEffect(() => {
    let raf = 0
    let last = 0
    const draw = (t: number) => {
      raf = requestAnimationFrame(draw)
      if (t - last < 33) return
      last = t
      const lv = levels()
      for (const [id, el] of bars.current) {
        const rms = lv.get(id) ?? 0
        const db = rms > 0 ? 20 * Math.log10(rms) : -100
        const pct = Math.max(0, Math.min(1, (db + 54) / 48))
        el.style.transform = `scaleX(${pct})`
        el.style.backgroundColor = db > -6 ? '#FB7185' : db > -14 ? '#FBBF24' : '#4ADE80'
      }
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [levels])
  return (id: string) => (el: HTMLSpanElement | null) => {
    if (el) bars.current.set(id, el)
    else bars.current.delete(id)
  }
}

export function MicPopover({ mic, player }: { mic: MicControl; player: PlayerState }) {
  const meter = useMeters(mic)
  const rows = [
    { id: DEFAULT_MIC, label: '系统默认' },
    ...mic.devices.map((d, i) => ({ id: d.deviceId, label: d.label || `麦克风 ${i + 1}` })),
  ]
  const multi = mic.selected.filter((id) => id !== DEFAULT_MIC).length > 1
  const noLabels = mic.devices.length > 0 && mic.devices.every((d) => !d.label)
  const allDenied = mic.on && mic.status === 'error' && [...mic.errors.values()].every((e) => e === 'denied')
  const insecure = !window.isSecureContext
  const pct = (v: number) => Math.round(v * 100)

  return (
    <div
      role="dialog"
      aria-label="麦克风"
      className="glass flex max-h-[70vh] w-[400px] flex-col gap-4 overflow-y-auto rounded-[20px] p-5 shadow-[0_24px_60px_rgba(0,0,0,0.55)]"
    >
      <div className="flex items-center gap-3">
        <span
          className={clsx(
            'flex h-10 w-10 shrink-0 items-center justify-center rounded-[14px]',
            mic.on ? 'bg-ok-dot/15 text-ok' : 'bg-white/8 text-fg-2',
          )}
        >
          <Icon name="mic" size={20} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="text-[17px] font-semibold">麦克风</span>
          <span className="truncate text-[13px] text-muted">
            {!mic.on
              ? '和歌曲一起从这块大屏播放'
              : mic.status === 'starting'
                ? '正在打开…'
                : mic.status === 'on'
                  ? '已打开'
                  : '没能打开麦克风'}
          </span>
        </div>
        <Switch checked={mic.on} onChange={mic.setOn} label="麦克风开关" disabled={insecure} />
      </div>

      {insecure && <p className="m-0 text-[13px] leading-5 text-warn">{errorText.insecure}</p>}
      {allDenied && <p className="m-0 text-[13px] leading-5 text-warn">{errorText.denied}</p>}

      <div className="flex flex-col gap-1.5">
        <span className="text-[13px] text-muted">输入设备（可选多个）</span>
        {rows.map((r) => {
          const selected = mic.selected.includes(r.id)
          const err = mic.on ? mic.errors.get(r.id) : undefined
          return (
            <div key={r.id || 'default'} className={clsx('flex flex-col gap-2 rounded-[14px] px-3 py-2.5', selected ? 'bg-white/8' : 'bg-white/3')}>
              <button
                type="button"
                role="checkbox"
                aria-checked={selected}
                onClick={() => mic.toggleDevice(r.id)}
                className="flex items-center gap-3 text-left"
              >
                <span
                  className={clsx(
                    'flex h-5 w-5 shrink-0 items-center justify-center rounded-md border',
                    selected ? 'border-accent bg-accent text-accent-ink' : 'border-white/25',
                  )}
                >
                  {selected && <Icon name="check" size={14} strokeWidth={2.6} />}
                </span>
                <span className="min-w-0 flex-1 truncate text-[15px]">{r.label}</span>
                {selected && mic.on && mic.status !== 'off' && !err && (
                  <span className="relative h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-white/12">
                    <span
                      ref={meter(r.id)}
                      style={{ transform: 'scaleX(0)' }}
                      className="absolute inset-0 origin-left rounded-full bg-ok-dot transition-transform duration-75"
                    />
                  </span>
                )}
              </button>
              {err && err !== 'denied' && <span className="pl-8 text-[12px] text-warn">{errorText[err]}</span>}
              {selected && multi && (
                <div className="flex items-center gap-2 pl-8">
                  <span className="shrink-0 text-[12px] text-muted">音量</span>
                  <div className="min-w-0 flex-1">
                    <Range
                      label={`${r.label} 音量`}
                      value={Math.round((mic.gains[r.id] ?? 1) * 100)}
                      max={200}
                      onChange={(v) => mic.setGain(r.id, v / 100)}
                      color="#FFFFFF"
                    />
                  </div>
                  <span className="num w-11 shrink-0 text-right text-[12px] text-[#C8C8D0]">{Math.round((mic.gains[r.id] ?? 1) * 100)}%</span>
                </div>
              )}
            </div>
          )
        })}
        {noLabels && <span className="text-[12px] text-faint">打开麦克风并允许权限后显示设备名称</span>}
      </div>

      <div className="flex flex-col gap-3.5 border-t border-white/8 pt-4">
        <SliderRow icon="mic" label="音量" value={pct(player.micVolume)} onChange={(v) => setPlayer({ micVolume: v / 100 })} />
        <SliderRow icon="sparkles" label="混响" value={pct(player.reverb)} onChange={(v) => setPlayer({ reverb: v / 100 })} />
      </div>
    </div>
  )
}

function SliderRow({ icon, label, value, onChange }: { icon: 'mic' | 'sparkles'; label: string; value: number; onChange: (v: number) => void }) {
  return (
    <div className="flex items-center gap-3">
      <Icon name={icon} size={18} className="shrink-0 text-fg-2" />
      <span className="w-10 shrink-0 text-[15px] whitespace-nowrap">{label}</span>
      <div className="min-w-0 flex-1">
        <Range label={'麦克风' + label} value={value} onChange={onChange} color="#FFFFFF" />
      </div>
      <span className="num w-11 shrink-0 text-right text-[15px] text-[#C8C8D0]">{value}%</span>
    </div>
  )
}

/** The button with its own popover, for screens without the control bar (the idle page). */
export function MicCorner({ mic }: { mic: MicControl }) {
  const player = useApp((s) => s.state.player)
  const [open, setOpen] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])
  return (
    <div ref={boxRef} className="relative text-left">
      {open && (
        <div className="absolute right-0 bottom-full z-20 mb-3">
          <MicPopover mic={mic} player={player} />
        </div>
      )}
      <MicButton mic={mic} open={open} onToggle={() => setOpen((v) => !v)} />
    </div>
  )
}
