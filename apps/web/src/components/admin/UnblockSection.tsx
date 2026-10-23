import clsx from 'clsx'
import type { AdminSettings } from '@shared/types'
import { Icon } from '../icons'
import { Switch } from '../ui'
import { Card, Row, type SetFn } from './parts'

/** 后台 → 第三方音源: opt-in sources for songs NetEase has no audio for. */

export function UnblockSection({ draft, set, options }: { draft: AdminSettings; set: SetFn; options: string[] }) {
  return (
    <>
      <Card>
        <Row title="启用第三方音源（unblock）" help="只对网易云没有音源的歌生效。">
          <Switch checked={draft.unblockEnabled} onChange={(v) => set('unblockEnabled', v)} label="启用第三方音源" />
        </Row>
        {draft.unblockEnabled && options.length > 0 && (
          <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
            <legend className="mb-2 text-sm text-fg-2">允许的音源（按编号顺序尝试，第一个匹配到的生效）</legend>
            <div className="flex flex-wrap gap-2">
              {[...draft.unblockSources.filter((o) => options.includes(o)), ...options.filter((o) => !draft.unblockSources.includes(o))].map((o) => {
                const on = draft.unblockSources.includes(o)
                const rank = draft.unblockSources.indexOf(o)
                const earlier = () => {
                  const next = [...draft.unblockSources]
                  ;[next[rank - 1], next[rank]] = [next[rank]!, next[rank - 1]!]
                  set('unblockSources', next)
                }
                return (
                  <label
                    key={o}
                    className={clsx(
                      'num inline-flex h-9 cursor-pointer items-center gap-2 rounded-full border px-3 text-sm',
                      on ? 'border-white/40 bg-white/10 text-fg' : 'border-white/10 text-muted',
                    )}
                  >
                    {on && (
                      <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-white/14 px-1 text-[11px] font-semibold">
                        {rank + 1}
                      </span>
                    )}
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
                    {on && rank > 0 && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.preventDefault()
                          earlier()
                        }}
                        aria-label={`把 ${o} 提前`}
                        title="提前"
                        className="-mr-1.5 flex h-6 w-6 items-center justify-center rounded-full text-muted hover:bg-white/10 hover:text-fg"
                      >
                        <Icon name="chevronLeft" size={14} />
                      </button>
                    )}
                  </label>
                )
              })}
            </div>
          </fieldset>
        )}
      </Card>
      <div className="flex gap-3 rounded-2xl border border-[rgba(251,191,36,0.25)] bg-[rgba(251,191,36,0.08)] p-4 text-[13px] leading-6 text-fg-2">
        <Icon name="alert" size={18} className="mt-0.5 shrink-0 text-warn" />
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          <li>音频来自其他平台和个人运营的第三方解析站，授权状况不明，可能随时失效。</li>
          <li>
            只用于网易云没有版权的歌曲；会员歌、试听歌<strong className="text-fg">不会</strong>走第三方音源。
          </li>
          <li>开启后，点歌的歌曲 ID 会发送给这些第三方站点。</li>
          <li>匹配结果可能是不同版本，时长差异过大会被自动丢弃。仅限个人本地使用。</li>
        </ul>
      </div>
    </>
  )
}
