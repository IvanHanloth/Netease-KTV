import type { AdminSettings } from '@shared/types'
import { Switch } from '../ui'
import { ModelSection } from './AudioSection'
import { Card, ChoiceCard, Row, type SetFn } from './parts'

/**
 * 伴奏来源: NetEase's own 随心唱 stems first (AI separation for songs without them, or the
 * original), or AI separation for every song. The AI model card below is the fallback's model
 * in the first case.
 */
export function StemSection({ draft, set }: { draft: AdminSettings; set: SetFn }) {
  const official = draft.stemSource === 'official'
  const aiUsed = !official || draft.stemFallback
  return (
    <>
      <Card title="伴奏来源">
        <div role="radiogroup" aria-label="伴奏来源" className="flex flex-col gap-2">
          <ChoiceCard
            on={official}
            onClick={() => set('stemSource', 'official')}
            title="优先用网易云官方伴奏"
            note="App 里“随心唱”用的伴奏和人声分轨，点歌后几秒就好，不占分离服务器。官方伴奏里没有和声，约六成热门歌有。"
          />
          <ChoiceCard
            on={!official}
            onClick={() => set('stemSource', 'ai')}
            title="全部用 AI 分离"
            note="每首歌都用下面的模型分离，karaoke 模型只去掉主唱、保留和声，唱起来更饱满。需要分离服务器，每首要等一会儿。"
          />
        </div>
        {official && (
          <Row
            title="没有官方伴奏时用 AI 分离"
            help={draft.stemFallback ? '用下面选的模型分离。' : '关闭后，这些歌直接播放原曲（带原唱）。'}
          >
            <Switch checked={draft.stemFallback} onChange={(v) => set('stemFallback', v)} label="没有官方伴奏时用 AI 分离" />
          </Row>
        )}
      </Card>
      <div className={aiUsed ? undefined : 'pointer-events-none opacity-45'} aria-disabled={!aiUsed}>
        <ModelSection draft={draft} set={set} title={official ? '替补的 AI 分离模型' : 'AI 分离模型'} />
      </div>
    </>
  )
}
