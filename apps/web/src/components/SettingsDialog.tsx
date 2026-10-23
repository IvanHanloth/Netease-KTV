import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { MvResolution, Settings, SoundLevel } from '@shared/types'
import { api } from '../lib/api'
import { errorText, toast, useCacheInfo, useSettings } from '../lib/hooks'
import { DEFAULT_TOLERANCE, TOLERANCE_PRESETS } from '../player/scoring'
import { Dialog, ProgressBar, Range, Spinner, Switch } from './ui'
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
            <ToleranceControl
              value={draft.scoreTolerance ?? DEFAULT_TOLERANCE}
              onChange={(v) => set('scoreTolerance', v)}
              disabled={draft.scoringEnabled === false}
            />
          </section>

          <VideoCacheSection draft={draft} set={set} open={open} />

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

const GB = 1024 ** 3
const gb = (bytes: number) => (bytes / GB).toFixed(bytes >= 10 * GB ? 0 : 1)
const resolutions: MvResolution[] = [480, 720, 1080]

/** 视频与缓存: MV preload, MV resolution, cache size limit + usage + 清空缓存. */
function VideoCacheSection({
  draft,
  set,
  open,
}: {
  draft: Settings
  set: <K extends keyof Settings>(k: K, v: Settings[K]) => void
  open: boolean
}) {
  const qc = useQueryClient()
  const cache = useCacheInfo(open)
  const [confirming, setConfirming] = useState(false)
  const [clearing, setClearing] = useState(false)
  useEffect(() => {
    if (!open) setConfirming(false)
  }, [open])
  const limitGB = Math.round(draft.cacheLimitGB ?? 20)
  const used = cache.data?.usedBytes ?? 0
  const ratio = Math.min(1, used / (limitGB * GB))

  async function clear() {
    setClearing(true)
    try {
      await api.clearCache()
      toast('缓存已清空（正在唱和已点的歌会保留）')
      await qc.invalidateQueries({ queryKey: ['cache'] })
    } catch (e) {
      toast(errorText(e), 'error')
    } finally {
      setClearing(false)
      setConfirming(false)
    }
  }

  return (
    <section className="flex flex-col gap-4">
      <h3 className="m-0 text-xs tracking-[0.12em] text-subtle">视频与缓存</h3>
      <div className="flex items-center justify-between gap-4">
        <div className="flex flex-col gap-1">
          <span className="text-[15px] font-semibold">预载 MV</span>
          <span className="text-xs text-muted">提前下载已点歌曲的 MV，播放更流畅，并用于自动对齐</span>
        </div>
        <Switch checked={draft.mvPreload ?? true} onChange={(v) => set('mvPreload', v)} label="预载 MV" />
      </div>

      <div className="flex flex-col gap-2.5">
        <span className="text-sm text-fg-2">MV 清晰度</span>
        <div role="radiogroup" aria-label="MV 清晰度" className="grid grid-cols-3 gap-1 rounded-xl bg-white/5 p-1">
          {resolutions.map((r) => {
            const on = (draft.mvResolution ?? 720) === r
            return (
              <button
                key={r}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => set('mvResolution', r)}
                className={
                  'num h-9 rounded-lg text-sm whitespace-nowrap transition-colors ' +
                  (on ? 'bg-fg font-semibold text-ink' : 'text-fg-2 hover:bg-white/8')
                }
              >
                {r}P
              </button>
            )
          })}
        </div>
        <span className="text-xs text-muted">清晰度越高越占空间，网络慢时建议 720P 或 480P。</span>
      </div>

      <div className="flex flex-col gap-2.5">
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm text-fg-2">缓存上限</span>
          <label className="flex items-center gap-1.5">
            <span className="sr-only-x">缓存上限（GB）</span>
            <input
              type="number"
              inputMode="numeric"
              min={1}
              max={500}
              step={1}
              value={limitGB}
              onChange={(e) => {
                const n = Math.round(Number(e.target.value))
                if (Number.isFinite(n)) set('cacheLimitGB', Math.min(500, Math.max(1, n)))
              }}
              className="num h-9 w-20 rounded-lg border border-white/10 bg-white/5 px-2 text-right text-sm text-fg outline-none focus:border-white/25"
            />
            <span className="text-sm text-muted">GB</span>
          </label>
        </div>
        <Range label="缓存上限（GB）" min={1} max={500} value={limitGB} onChange={(n) => set('cacheLimitGB', n)} />
        <div className="flex flex-col gap-2 rounded-2xl border border-white/8 bg-white/4 p-3.5">
          {cache.isLoading ? (
            <span className="flex items-center gap-2 text-xs text-muted">
              <Spinner size={13} /> 读取缓存占用…
            </span>
          ) : cache.isError ? (
            <span className="flex items-center gap-2 text-xs text-muted">
              缓存占用读取失败
              <button type="button" onClick={() => cache.refetch()} className="text-accent-soft hover:underline">
                重试
              </button>
            </span>
          ) : (
            <>
              <ProgressBar value={ratio} color={ratio > 0.9 ? '#FBBF24' : '#FF4D7E'} />
              <span className="num text-xs leading-5 text-fg-2">
                已用 {gb(used)} GB / 上限 {limitGB} GB（音频 {gb(cache.data?.audioBytes ?? 0)} GB · MV {gb(cache.data?.mvBytes ?? 0)} GB）
              </span>
            </>
          )}
          <span className="text-xs leading-5 text-muted">超出上限时自动清理最久没唱的歌；正在唱和已点的歌不会被清理。</span>
          <div className="flex justify-end gap-2">
            {confirming ? (
              <>
                <button
                  type="button"
                  onClick={() => setConfirming(false)}
                  className="h-9 rounded-lg px-3 text-sm whitespace-nowrap text-muted hover:text-fg"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={clear}
                  disabled={clearing}
                  className="flex h-9 items-center gap-1.5 rounded-lg bg-[rgba(255,77,126,0.16)] px-3 text-sm font-semibold whitespace-nowrap text-accent-soft disabled:opacity-60"
                >
                  {clearing && <Spinner size={13} />}
                  确认清空
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => setConfirming(true)}
                className="flex h-9 items-center gap-1.5 rounded-lg bg-white/6 px-3 text-sm whitespace-nowrap text-fg-2 hover:bg-white/10"
              >
                <Icon name="trash" size={15} />
                清空缓存
              </button>
            )}
          </div>
        </div>
      </div>
    </section>
  )
}
