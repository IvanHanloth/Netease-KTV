import type { AdminSettings } from '@shared/types'
import { Switch } from '../ui'
import { Card, Row, Segmented, type SetFn } from './parts'

const QR_SECONDS = [30, 60, 90, 120]
const KEEP_HOURS = [6, 24, 72, 168]

/** The presets, plus the saved value when it is something else (set through the environment). */
const withCurrent = (presets: number[], v: number) => (presets.includes(v) ? presets : [...presets, v].sort((a, b) => a - b))

const hoursLabel = (h: number) => (h % 24 === 0 ? `${h / 24} 天` : `${h} 小时`)

/** 录制: the house default for the 点歌台 switch, and how long recordings are offered and kept. */
export function RecordSection({ draft, set }: { draft: AdminSettings; set: SetFn }) {
  return (
    <Card>
      <Row
        title="录制每首歌"
        help="主屏录下麦克风的声音。歌唱完后大屏显示二维码，扫码就能下载伴奏加人声的合成音频，或合成 MV、歌词视频。点歌台控制台里也能随时开关。"
      >
        <Switch checked={draft.recordEnabled} onChange={(v) => set('recordEnabled', v)} label="录制每首歌" />
      </Row>
      <Row stack title="二维码显示多久" help="倒计时结束前没人扫码，录音会被删除。">
        <Segmented
          label="二维码显示时长"
          value={draft.recordQrSeconds}
          options={withCurrent(QR_SECONDS, draft.recordQrSeconds).map((s) => ({ value: s, label: `${s} 秒` }))}
          onChange={(v) => set('recordQrSeconds', v)}
        />
      </Row>
      <Row stack title="扫码后保留多久" help="到时间后录音和合成好的视频一起删除。">
        <Segmented
          label="录音保留时长"
          value={draft.recordKeepHours}
          options={withCurrent(KEEP_HOURS, draft.recordKeepHours).map((h) => ({ value: h, label: hoursLabel(h) }))}
          onChange={(v) => set('recordKeepHours', v)}
        />
      </Row>
    </Card>
  )
}
