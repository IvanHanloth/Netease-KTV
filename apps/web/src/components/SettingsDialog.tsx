import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { DeskSettings } from '@shared/types'
import { api } from '../lib/api'
import { errorText, toast, useSettings } from '../lib/hooks'
import { DEFAULT_TOLERANCE, TOLERANCE_PRESETS } from '../player/scoring'
import { Dialog, Range, Switch } from './ui'

/**
 * 点歌台设置: only what singers should control. Audio quality, separation model, LAN address,
 * caches and third-party sources are ops settings and live in 后台管理 (/admin).
 */
export function SettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient()
  const { data } = useSettings()
  const [draft, setDraft] = useState<DeskSettings | null>(null)
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    if (open && data) setDraft({ scoringEnabled: data.scoringEnabled, scoreTolerance: data.scoreTolerance })
  }, [open, data])

  const set = <K extends keyof DeskSettings>(k: K, v: DeskSettings[K]) => setDraft((d) => (d ? { ...d, [k]: v } : d))

  async function save() {
    if (!draft) return
    setSaving(true)
    try {
      const res = await api.saveSettings(draft)
      qc.setQueryData(['settings'], res)
      toast('设置已保存')
      onClose()
    } catch (e) {
      toast(errorText(e), 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title="设置" width={480}>
      {!draft ? (
        <p className="py-8 text-center text-sm text-muted">加载中…</p>
      ) : (
        <div className="flex flex-col gap-6 pt-2">
          <section className="flex flex-col gap-4">
            <h3 className="m-0 text-xs tracking-[0.12em] text-subtle">演唱</h3>
            <div className="flex items-center justify-between gap-4">
              <div className="flex flex-col gap-1">
                <span className="text-[15px] font-semibold">KTV 打分</span>
                <span className="text-xs text-muted">需要伴奏分离生成的主唱音高，以及主屏设备上的麦克风</span>
              </div>
              <Switch
                checked={draft.scoringEnabled ?? true}
                onChange={(v) => set('scoringEnabled', v)}
                label="KTV 打分"
              />
            </div>
            <ToleranceControl
              value={draft.scoreTolerance ?? DEFAULT_TOLERANCE}
              onChange={(v) => set('scoreTolerance', v)}
              disabled={draft.scoringEnabled === false}
            />
          </section>

          <div className="flex justify-end gap-3">
            <button type="button" onClick={onClose} className="h-11 rounded-xl px-4 text-sm text-muted hover:text-fg">
              取消
            </button>
            <button
              type="button"
              onClick={save}
              disabled={saving}
              className="h-11 rounded-xl bg-accent px-5 text-sm font-bold text-accent-ink disabled:opacity-50"
            >
              {saving ? '保存中…' : '保存'}
            </button>
          </div>
        </div>
      )}
    </Dialog>
  )
}

/** 打分容错: presets plus a fine slider (0.3–3.0 semitones). */
function ToleranceControl({ value, onChange, disabled }: { value: number; onChange: (v: number) => void; disabled?: boolean }) {
  const v = Math.round(value * 10) / 10
  return (
    <div className={'flex flex-col gap-2.5' + (disabled ? ' pointer-events-none opacity-45' : '')} aria-disabled={disabled}>
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm text-fg-2">打分容错</span>
        <span className="num text-sm font-semibold whitespace-nowrap text-accent">±{v.toFixed(1)} 个半音</span>
      </div>
      <div role="radiogroup" aria-label="打分容错预设" className="grid grid-cols-3 gap-1 rounded-xl bg-white/5 p-1">
        {TOLERANCE_PRESETS.map((p) => {
          const on = Math.abs(v - p.value) < 0.05
          return (
            <button
              key={p.label}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => onChange(p.value)}
              className={
                'h-9 rounded-lg text-sm whitespace-nowrap transition-colors ' +
                (on ? 'bg-fg font-semibold text-ink' : 'text-fg-2 hover:bg-white/8')
              }
            >
              {p.label} <span className="num opacity-70">±{p.value.toFixed(1)}</span>
            </button>
          )
        })}
      </div>
      <Range label="打分容错（半音）" min={3} max={30} value={Math.round(v * 10)} onChange={(n) => onChange(n / 10)} />
      <span className="text-xs leading-5 text-muted">
        音高误差在这个范围内拿满分，超出后逐渐减分（到 3 倍时为 0）。越大越宽松，不区分八度。
      </span>
    </div>
  )
}
