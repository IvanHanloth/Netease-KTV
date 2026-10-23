import { type ReactNode } from 'react'
import { Link } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import clsx from 'clsx'
import type { AdminStatus } from '@shared/types'
import { api } from '../../lib/api'
import { fmtBytes } from '../../lib/format'
import { errorText, useAccount, useCacheInfo } from '../../lib/hooks'
import { Icon, type IconName } from '../icons'
import { ProgressBar, TONE_DOT, type Tone } from '../ui'
import { separatorPhase, SEPARATOR_LABEL, SEPARATOR_TONE } from '../../lib/separator'
import { Card } from './parts'

/** 后台 → 运行状态: service, account, cache and device tiles, refreshed every 5 s. */

export function useAdminStatus() {
  return useQuery({ queryKey: ['admin-status'], queryFn: api.adminStatus, refetchInterval: 5000, staleTime: 0 })
}

export function duration(sec: number) {
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  if (d) return `${d} 天 ${h} 小时`
  if (h) return `${h} 小时 ${m} 分`
  return `${Math.max(1, m)} 分钟`
}

/** The shared separator reading (lib/separator.ts), plus how busy the cluster is when it is up. */
export function separatorState(s: AdminStatus['separator'] | undefined): { tone: Tone; text: string } {
  const phase = separatorPhase(s)
  if (phase === 'ready') return { tone: 'ok', text: s!.busyNodes > 0 ? `${s!.busyNodes} 台工作中` : '空闲' }
  if (phase === 'offline') return { tone: 'bad', text: (s?.nodes ?? 0) > 1 ? '全部离线' : '离线' }
  return { tone: SEPARATOR_TONE[phase], text: SEPARATOR_LABEL[phase] }
}

export function StatusTile({
  icon,
  label,
  tone,
  value,
  sub,
  onClick,
  href,
}: {
  icon: IconName
  label: string
  tone: Tone
  value: ReactNode
  sub?: ReactNode
  /** Opens the section that manages this. */
  onClick?: () => void
  /** Opens a page in a new tab (e.g. /tv). */
  href?: string
}) {
  const cls = clsx(
    'flex min-w-0 flex-col gap-3 rounded-2xl border border-white/7 bg-white/[0.025] p-4 text-left',
    (onClick || href) && 'transition-colors hover:border-white/14 hover:bg-white/[0.045]',
  )
  const body = (
    <>
      <div className="flex items-center gap-2 text-xs text-subtle">
        <Icon name={icon} size={15} />
        {label}
        <span className={clsx('ml-auto h-2 w-2 rounded-full', TONE_DOT[tone])} />
      </div>
      <div className="truncate text-lg font-bold">{value}</div>
      {sub && <div className="min-h-[18px] truncate text-xs text-muted">{sub}</div>}
    </>
  )
  if (href)
    return (
      <Link to={href} target="_blank" className={cls}>
        {body}
      </Link>
    )
  if (onClick)
    return (
      <button type="button" onClick={onClick} className={cls}>
        {body}
      </button>
    )
  return <div className={cls}>{body}</div>
}

export function Overview({ go }: { go: (id: 'separators' | 'storage') => void }) {
  const status = useAdminStatus()
  const { data: account } = useAccount()
  const cache = useCacheInfo()
  const s = status.data
  const sep = separatorState(s?.separator)
  const used = cache.data?.usedBytes ?? 0
  const limit = cache.data?.limitBytes ?? 0
  const ratio = limit ? Math.min(1, used / limit) : 0

  if (status.isError && !s)
    return (
      <Card>
        <div className="flex items-center justify-between gap-3 text-sm text-muted">
          {errorText(status.error)}
          <button type="button" onClick={() => status.refetch()} className="text-accent-soft hover:underline">
            重试
          </button>
        </div>
      </Card>
    )

  return (
    <>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <StatusTile
          icon="wave"
          label="伴奏分离服务器"
          onClick={() => go('separators')}
          tone={sep.tone}
          value={sep.text}
          sub={
            s &&
            (s.separator.nodes
              ? `${s.separator.onlineNodes} / ${s.separator.nodes} 台在线${s.separator.pending ? ` · ${s.separator.pending} 首待处理` : ''}`
              : '在“分离服务器”里添加，否则只能播放原曲')
          }
        />
        <StatusTile
          icon="user"
          label="网易云账号"
          tone={account ? (account.loggedIn ? 'ok' : 'warn') : 'idle'}
          value={account ? (account.loggedIn ? account.nickname : '未登录') : '读取中'}
          href={account && !account.loggedIn ? '/' : undefined}
          sub={account?.loggedIn ? (account.vipType ? '黑胶 VIP' : '普通账号') : '在点歌台扫码登录'}
        />
        <StatusTile
          icon="database"
          label="缓存占用"
          onClick={() => go('storage')}
          tone={!cache.data ? 'idle' : ratio > 0.9 ? 'warn' : 'ok'}
          value={
            cache.data ? (
              <span className="num">
                {fmtBytes(used)} <span className="text-sm font-medium text-muted">/ {fmtBytes(limit)}</span>
              </span>
            ) : (
              '读取中'
            )
          }
          sub={cache.data && <ProgressBar value={ratio} color={ratio > 0.9 ? '#FBBF24' : '#8B7BFF'} className="mt-1.5" />}
        />
        <StatusTile
          icon="tv"
          label="在线设备"
          href={s && s.clients.tv === 0 ? '/tv' : undefined}
          tone={!s ? 'idle' : s.clients.tv > 0 ? 'ok' : 'warn'}
          value={
            s ? (
              <span className="num">
                大屏 {s.clients.tv}
                <span className="text-sm font-medium text-muted">
                  {' '}· 点歌台 {s.clients.desk} · 手机 {s.clients.remote}
                  {s.clients.ear > 0 && ` · 耳返 ${s.clients.ear}`}
                </span>
              </span>
            ) : (
              '读取中'
            )
          }
          sub={s && (s.clients.tv > 0 ? (s.clients.tv > 1 ? `${s.clients.tv} 块大屏，其中一块是主屏` : '大屏已连接') : '没有打开的大屏，点歌后不会播放')}
        />
      </div>

      <Card title="服务信息">
        <dl className="m-0 grid grid-cols-1 gap-x-6 gap-y-3.5 text-sm sm:grid-cols-[140px_minmax(0,1fr)]">
          <Info k="版本" v={s && <span className="num">v{s.version}</span>} />
          <Info k="已运行" v={s && duration(s.uptimeSec)} />
          <Info k="Node.js" v={s && <span className="num">{s.node}</span>} />
          <Info k="最快的分离设备" v={s?.separator.device && <span className="num">{s.separator.device}</span>} />
          <Info k="数据目录" v={s && <span className="num break-all">{s.dataDir}</span>} />
          <Info k="访问令牌" v={s && (s.authEnabled ? '已启用（ACCESS_TOKEN）' : '未启用，局域网内任何人都能访问')} />
        </dl>
      </Card>
    </>
  )
}

export function Info({ k, v }: { k: string; v: ReactNode }) {
  return (
    <>
      <dt className="text-muted">{k}</dt>
      <dd className="m-0 min-w-0 text-fg-2">{v ?? <span className="text-faint">—</span>}</dd>
    </>
  )
}
