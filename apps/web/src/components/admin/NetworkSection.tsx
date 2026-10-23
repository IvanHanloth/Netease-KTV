import clsx from 'clsx'
import type { AdminSettings } from '@shared/types'
import { Icon } from '../icons'
import { Card, inputCls, Row, type SetFn } from './parts'

/** 后台 → 网络: the address phones open from the 大屏 QR code. */

export function isLocalHost(host: string) {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]'
}

export function NetworkSection({ draft, set }: { draft: AdminSettings; set: SetFn }) {
  const origin = window.location.origin
  const browserIsLan = !isLocalHost(window.location.hostname)
  const value = draft.publicUrl.trim().replace(/\/+$/, '')
  const invalid = !!value && !/^https?:\/\/[^\s/]+/i.test(value)
  const effective = value || origin
  return (
    <Card title="扫码点歌地址">
      <Row stack title="局域网地址" help="手机扫大屏上的二维码打开的地址。留空时用打开大屏的浏览器地址。">
        <input
          value={draft.publicUrl}
          onChange={(e) => set('publicUrl', e.target.value)}
          placeholder="http://192.168.1.8:8686"
          aria-label="局域网地址"
          aria-invalid={invalid}
          className={clsx(inputCls, 'num', invalid && 'border-[rgba(255,77,126,0.6)]!')}
        />
        {invalid && <span className="text-xs text-accent-soft">要以 http:// 或 https:// 开头</span>}
        {browserIsLan && value !== origin && (
          <button
            type="button"
            onClick={() => set('publicUrl', origin)}
            className="flex h-9 items-center gap-1.5 self-start rounded-lg bg-white/6 px-3 text-sm text-fg-2 hover:bg-white/10"
          >
            <Icon name="globe" size={15} />
            使用当前地址 <span className="num text-muted">{origin}</span>
          </button>
        )}
      </Row>
      <div className="flex flex-col gap-1.5 rounded-2xl border border-white/8 bg-white/4 p-3.5">
        <span className="text-xs text-subtle">手机将打开</span>
        <span className="num text-sm break-all text-fg">{effective}/m</span>
        {!value && isLocalHost(window.location.hostname) && (
          <span className="flex items-center gap-1.5 text-xs text-warn">
            <Icon name="alert" size={14} />
            大屏如果也用 localhost 打开，手机会扫不进来，请填写本机局域网 IP。
          </span>
        )}
      </div>
    </Card>
  )
}
