import { useState } from 'react'
import type { AdminSettings, SoundLevel } from '@shared/types'
import { Card, ChoiceCard, inputCls, MODELS, Row, Segmented, type SetFn } from './parts'

/** 后台 → 下载音质, and the default separation model shown under 分离服务器. */

export const LEVELS: { value: SoundLevel; label: string; note: string }[] = [
  { value: 'standard', label: '标准', note: '128k' },
  { value: 'higher', label: '较高', note: '192k' },
  { value: 'exhigh', label: '极高', note: '320k' },
  { value: 'lossless', label: '无损', note: 'FLAC' },
  { value: 'hires', label: 'Hi-Res', note: '' },
]

export function AudioSection({ draft, set }: { draft: AdminSettings; set: SetFn }) {
  return (
    <>
      <Card title="下载音质">
        <Row
          stack
          title="网易云音质"
          help="实际音质受账号权益限制，拿不到时自动降一档。音质越高，下载和分离越慢。"
        >
          <Segmented
            label="下载音质"
            value={draft.audioLevel}
            onChange={(v) => set('audioLevel', v)}
            options={LEVELS.map((l) => ({
              value: l.value,
              label: (
                <>
                  {l.label}
                  {l.note && <span className="num ml-1 hidden opacity-60 sm:inline">{l.note}</span>}
                </>
              ),
            }))}
          />
        </Row>
      </Card>
    </>
  )
}

/** Default separation model (each server can override it). Saved with the rest of the draft. */
export function ModelSection({ draft, set }: { draft: AdminSettings; set: SetFn }) {
  const preset = MODELS.some((m) => m.value === draft.separatorModel)
  const [custom, setCustom] = useState(!preset)
  return (
    <>
      <Card title="默认分离模型">
        <div role="radiogroup" aria-label="分离模型" className="flex flex-col gap-2">
          {MODELS.map((m) => (
            <ChoiceCard
              key={m.value || 'auto'}
              on={!custom && draft.separatorModel === m.value}
              onClick={() => {
                setCustom(false)
                set('separatorModel', m.value)
              }}
              title={m.label}
              note={m.note}
            />
          ))}
          <ChoiceCard on={custom} onClick={() => setCustom(true)} title="自定义" note="填写 audio-separator 支持的模型文件名" />
        </div>
        {custom && (
          <input
            value={draft.separatorModel}
            onChange={(e) => set('separatorModel', e.target.value)}
            placeholder="例如 UVR-MDX-NET-Voc_FT.onnx"
            aria-label="自定义模型文件名"
            className={inputCls + ' num'}
          />
        )}
        <p className="m-0 text-xs leading-5 text-muted">
          karaoke 类模型只去掉主唱、保留和声，唱起来不空。换模型后，第一次分离会先下载模型文件。需要保存。
        </p>
      </Card>
    </>
  )
}
