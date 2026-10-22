import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { Settings, SoundLevel } from '@shared/types'
import { api } from '../lib/api'
import { errorText, toast, useSettings } from '../lib/hooks'
import { Dialog, Switch } from './ui'
import { Icon } from './icons'

const levels: { value: SoundLevel; label: string }[] = [
  { value: 'standard', label: '标准（128k）' },
  { value: 'higher', label: '较高（192k）' },
  { value: 'exhigh', label: '极高（320k）' },
  { value: 'lossless', label: '无损（FLAC）' },
  { value: 'hires', label: 'Hi-Res' },
]

const inputCls =
  'h-11 w-full rounded-xl border border-white/10 bg-white/5 px-3 text-sm text-fg outline-none placeholder:text-faint focus:border-white/25'

export function SettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient()
  const { data } = useSettings()
  const [draft, setDraft] = useState<Settings | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (open && data) {
      const { unblockSourceOptions: _ignored, ...rest } = data
      void _ignored
      setDraft(rest)
    }
  }, [open, data])

  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setDraft((d) => (d ? { ...d, [k]: v } : d))

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

  const options = data?.unblockSourceOptions ?? []

  return (
    <Dialog open={open} onClose={onClose} title="设置" width={560}>
      {!draft ? (
        <p className="py-8 text-center text-sm text-muted">加载中…</p>
      ) : (
        <div className="flex flex-col gap-6 pt-2">
          <section className="flex flex-col gap-4">
            <h3 className="m-0 text-xs tracking-[0.12em] text-subtle">播放与分离</h3>
            <label className="flex flex-col gap-2">
              <span className="text-sm text-fg-2">下载音质</span>
              <select
                value={draft.audioLevel}
                onChange={(e) => set('audioLevel', e.target.value as SoundLevel)}
                className={inputCls + ' appearance-none'}
              >
                {levels.map((l) => (
                  <option key={l.value} value={l.value} className="bg-panel">
                    {l.label}
                  </option>
                ))}
              </select>
              <span className="text-xs text-muted">实际音质受账号权益限制；音质越高，下载和分离越慢。</span>
            </label>
            <label className="flex flex-col gap-2">
              <span className="text-sm text-fg-2">分离模型</span>
              <input
                value={draft.separatorModel}
                onChange={(e) => set('separatorModel', e.target.value)}
                placeholder="mel_band_roformer_karaoke_aufr33_viperx_sdr_10.1956.ckpt"
                className={inputCls + ' num'}
              />
              <span className="text-xs text-muted">audio-separator 的模型文件名。karaoke 类模型只去主唱、保留和声。</span>
            </label>
            <label className="flex flex-col gap-2">
              <span className="text-sm text-fg-2">局域网地址（用于扫码点歌）</span>
              <input
                value={draft.publicUrl}
                onChange={(e) => set('publicUrl', e.target.value)}
                placeholder="http://192.168.1.8:8686"
                className={inputCls + ' num'}
              />
              <span className="text-xs text-muted">留空则使用当前浏览器地址。用 localhost 打开时请填写本机局域网 IP。</span>
            </label>
          </section>

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
          </section>

          <section className="flex flex-col gap-4">
            <h3 className="m-0 text-xs tracking-[0.12em] text-subtle">无音源歌曲</h3>
            <div className="flex items-center justify-between gap-4">
              <div className="flex flex-col gap-1">
                <span className="text-[15px] font-semibold">启用第三方音源（unblock）</span>
                <span className="text-xs text-muted">只对网易云没有音源的歌生效</span>
              </div>
              <Switch checked={draft.unblockEnabled} onChange={(v) => set('unblockEnabled', v)} label="启用第三方音源" />
            </div>
            <div className="flex gap-3 rounded-2xl border border-[rgba(251,191,36,0.25)] bg-[rgba(251,191,36,0.08)] p-4 text-[13px] leading-6 text-fg-2">
              <Icon name="alert" size={18} className="mt-0.5 shrink-0 text-warn" />
              <ul className="m-0 flex list-none flex-col gap-1 p-0">
                <li>音频来自其他平台和个人运营的第三方解析站，授权状况不明，可能随时失效。</li>
                <li>只用于网易云没有版权的歌曲；会员歌、试听歌<strong className="text-fg">不会</strong>走第三方音源。</li>
                <li>开启后，点歌的歌曲 ID 会发送给这些第三方站点。</li>
                <li>匹配结果可能是不同版本，时长差异过大会被自动丢弃。仅限个人本地使用。</li>
              </ul>
            </div>
            {draft.unblockEnabled && options.length > 0 && (
              <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
                <legend className="mb-2 text-sm text-fg-2">允许的音源（按顺序尝试）</legend>
                <div className="flex flex-wrap gap-2">
                  {options.map((o) => {
                    const on = draft.unblockSources.includes(o)
                    return (
                      <label
                        key={o}
                        className={
                          'num inline-flex h-9 cursor-pointer items-center gap-2 rounded-full border px-3 text-sm ' +
                          (on ? 'border-white/40 bg-white/10 text-fg' : 'border-white/10 text-muted')
                        }
                      >
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={(e) =>
                            set(
                              'unblockSources',
                              e.target.checked ? [...draft.unblockSources, o] : draft.unblockSources.filter((x) => x !== o),
                            )
                          }
                          className="accent-accent"
                        />
                        {o}
                      </label>
                    )
                  })}
                </div>
              </fieldset>
            )}
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
