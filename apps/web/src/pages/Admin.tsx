import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import type { AdminSettings, AdminStatus, MvResolution, SoundLevel } from '@shared/types'
import { api } from '../lib/api'
import { errorText, toast, useAccount, useCacheInfo, useSettings } from '../lib/hooks'
import { Icon, type IconName } from '../components/icons'
import { ProgressBar, Range, Spinner, Switch } from '../components/ui'
import { IdleSection } from '../components/admin/IdleSection'
import { SeparatorsSection } from '../components/admin/SeparatorsSection'
import { Card, ChoiceCard, inputCls, MODELS, Row, Segmented } from '../components/admin/parts'

/**
 * 后台管理 (/admin): the ops panel. Everything here changes how the server downloads, separates,
 * stores and serves music; the 点歌台 only keeps singing options. No auth yet.
 */

type SectionId = 'overview' | 'separators' | 'audio' | 'idle' | 'network' | 'storage' | 'unblock'

const SECTIONS: { id: SectionId; label: string; icon: IconName; keys: (keyof AdminSettings)[] }[] = [
  { id: 'overview', label: '运行状态', icon: 'info', keys: [] },
  { id: 'separators', label: '分离服务器', icon: 'server', keys: [] },
  { id: 'audio', label: '音质与分离', icon: 'wave', keys: ['audioLevel', 'separatorModel'] },
  { id: 'idle', label: '待机音乐', icon: 'note', keys: ['idleEnabled', 'idleVolume', 'idleSongs'] },
  { id: 'network', label: '网络', icon: 'globe', keys: ['publicUrl'] },
  { id: 'storage', label: '视频与缓存', icon: 'database', keys: ['mvPreload', 'mvResolution', 'cacheLimitGB'] },
  { id: 'unblock', label: '第三方音源', icon: 'link', keys: ['unblockEnabled', 'unblockSources'] },
]

const ADMIN_KEYS = SECTIONS.flatMap((s) => s.keys)

function sectionFromHash(): SectionId {
  const h = window.location.hash.slice(1)
  return SECTIONS.some((s) => s.id === h) ? (h as SectionId) : 'overview'
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

export default function Admin() {
  const qc = useQueryClient()
  const { data, isError, refetch } = useSettings()
  const [section, setSection] = useState<SectionId>(sectionFromHash)
  const [draft, setDraft] = useState<AdminSettings | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    document.title = '后台管理 · Netease KTV'
    const onHash = () => setSection(sectionFromHash())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  const saved = useMemo<AdminSettings | null>(() => {
    if (!data) return null
    const out = {} as Record<string, unknown>
    for (const k of ADMIN_KEYS) out[k] = data[k]
    return out as unknown as AdminSettings
  }, [data])
  useEffect(() => {
    if (saved && !draft) setDraft(saved)
  }, [saved, draft])

  const changed = useMemo(
    () => (draft && saved ? ADMIN_KEYS.filter((k) => !same(draft[k], saved[k])) : []),
    [draft, saved],
  )
  const dirty = changed.length > 0

  // Leaving with unsaved changes asks first.
  useEffect(() => {
    if (!dirty) return
    const warn = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  const set = <K extends keyof AdminSettings>(k: K, v: AdminSettings[K]) => setDraft((d) => (d ? { ...d, [k]: v } : d))

  function go(id: SectionId) {
    window.history.replaceState(null, '', '#' + id)
    setSection(id)
    document.getElementById('admin-main')?.scrollTo({ top: 0 })
  }

  async function save() {
    if (!draft || !dirty) return
    if (changed.includes('publicUrl') && draft.publicUrl && !/^https?:\/\/[^\s/]+/i.test(draft.publicUrl)) {
      go('network')
      toast('局域网地址要以 http:// 或 https:// 开头', 'error')
      return
    }
    setSaving(true)
    try {
      const patch = Object.fromEntries(changed.map((k) => [k, draft[k]])) as Partial<AdminSettings>
      const res = await api.saveAdminSettings(patch)
      qc.setQueryData(['settings'], res)
      setDraft(null) // re-seed from what the server actually stored
      void qc.invalidateQueries({ queryKey: ['cache'] })
      toast('设置已保存')
    } catch (e) {
      toast(errorText(e), 'error')
    } finally {
      setSaving(false)
    }
  }

  const current = SECTIONS.find((s) => s.id === section)!

  return (
    <div className="relative min-h-full overflow-hidden bg-ink text-fg lg:h-full">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-[420px] -left-[200px] h-[760px] w-[760px] rounded-full opacity-[0.12] blur-[20px]"
        style={{ background: 'radial-gradient(circle, #6D4BFF 0%, rgba(0,0,0,0) 62%)' }}
      />
      <div className="relative grid min-h-full grid-cols-1 lg:h-full lg:grid-cols-[248px_minmax(0,1fr)]">
        {/* Sidebar (desktop) / header + tabs (phone) */}
        <aside className="border-white/6 lg:min-h-0 lg:border-r">
          <nav aria-label="后台导航" className="flex flex-col gap-5 px-4 pt-5 pb-3 lg:h-full lg:gap-7 lg:py-7">
            <AdminBrand />
            <div className="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-1 lg:mx-0 lg:flex-col lg:gap-1 lg:overflow-visible lg:px-0 lg:pb-0">
              <div className="hidden px-3 pb-1.5 text-xs tracking-[0.12em] text-subtle lg:block">管理</div>
              {SECTIONS.map((s) => {
                const active = s.id === section
                const hasChanges = s.keys.some((k) => changed.includes(k))
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => go(s.id)}
                    aria-current={active ? 'page' : undefined}
                    className={clsx(
                      'flex shrink-0 items-center gap-3 rounded-xl px-3 text-left whitespace-nowrap transition-colors',
                      'h-10 text-sm lg:h-11 lg:w-full lg:text-[15px]',
                      active
                        ? 'bg-white/9 font-semibold text-fg'
                        : 'bg-white/4 text-[#C8C8D0] hover:bg-white/6 lg:bg-transparent lg:hover:bg-white/5',
                    )}
                  >
                    <Icon name={s.icon} size={19} className={active ? 'text-[#8B7BFF]' : undefined} />
                    <span className="lg:flex-1">{s.label}</span>
                    {hasChanges && <span aria-label="有未保存的更改" className="h-1.5 w-1.5 rounded-full bg-warn-dot" />}
                  </button>
                )
              })}
            </div>
            <div className="mt-auto hidden flex-col gap-1 lg:flex">
              <div className="px-3 pb-1.5 text-xs tracking-[0.12em] text-subtle">前台</div>
              <ExternalNav to="/" icon="search" label="点歌台" />
              <ExternalNav to="/tv" icon="tv" label="大屏" />
            </div>
          </nav>
        </aside>

        <main id="admin-main" className="min-w-0 px-4 pt-4 pb-32 sm:px-8 lg:overflow-y-auto lg:px-12 lg:pt-10">
          <div className="mx-auto flex max-w-[760px] flex-col gap-6">
            <header className="flex flex-col gap-1.5">
              <h1 className="m-0 text-2xl font-bold tracking-[0.01em] sm:text-[28px]">{current.label}</h1>
              <p className="m-0 text-sm text-muted">{SECTION_INTRO[section]}</p>
            </header>
            {isError && !draft ? (
              <Card>
                <div className="flex items-center justify-between gap-3 text-sm text-muted">
                  设置读取失败
                  <button type="button" onClick={() => refetch()} className="text-accent-soft hover:underline">
                    重试
                  </button>
                </div>
              </Card>
            ) : section === 'overview' ? (
              <Overview />
            ) : section === 'separators' ? (
              <SeparatorsSection />
            ) : !draft ? (
              <div className="flex justify-center py-16 text-muted">
                <Spinner size={24} />
              </div>
            ) : section === 'audio' ? (
              <AudioSection draft={draft} set={set} />
            ) : section === 'idle' ? (
              <IdleSection draft={draft} set={set} />
            ) : section === 'network' ? (
              <NetworkSection draft={draft} set={set} />
            ) : section === 'storage' ? (
              <StorageSection draft={draft} set={set} />
            ) : (
              <UnblockSection draft={draft} set={set} options={data?.unblockSourceOptions ?? []} />
            )}
          </div>
        </main>
      </div>

      {/* Unsaved-changes bar */}
      <div
        className={clsx(
          'pointer-events-none fixed inset-x-0 bottom-0 z-20 flex justify-center px-4 pb-[max(16px,env(safe-area-inset-bottom))] transition-all duration-200 lg:pl-[248px]',
          dirty ? 'translate-y-0 opacity-100' : 'translate-y-4 opacity-0',
        )}
      >
        <div
          role="status"
          className="pointer-events-auto flex w-full max-w-[760px] items-center gap-3 rounded-2xl border border-white/12 bg-[#1C1C26] py-2.5 pr-2.5 pl-4 shadow-[0_20px_60px_rgba(0,0,0,0.55)]"
          inert={!dirty}
        >
          <span className="h-2 w-2 shrink-0 rounded-full bg-warn-dot" />
          <span className="min-w-0 flex-1 truncate text-sm text-fg-2">
            <span className="num font-semibold text-fg">{changed.length}</span> 项更改未保存
          </span>
          <button
            type="button"
            onClick={() => setDraft(saved)}
            disabled={saving}
            className="h-10 shrink-0 rounded-xl px-3.5 text-sm whitespace-nowrap text-muted hover:text-fg"
          >
            撤销
          </button>
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="flex h-10 shrink-0 items-center gap-2 rounded-xl bg-accent px-4 text-sm font-bold whitespace-nowrap text-accent-ink disabled:opacity-60"
          >
            {saving && <Spinner size={14} />}
            保存更改
          </button>
        </div>
      </div>
    </div>
  )
}

const SECTION_INTRO: Record<SectionId, string> = {
  overview: '服务、账号、存储和在线设备的当前状态，每 5 秒刷新。',
  separators: '可以接入多台分离服务器一起处理点歌，本机不一定要运行分离服务。改动立即生效。',
  audio: '影响新下载和新分离的歌曲；已经生成好的伴奏不会重新处理。',
  idle: '没人点歌时，主屏小声循环播放的音乐。',
  network: '手机扫码点歌用的地址。',
  storage: 'MV 下载和本地缓存的空间管理。清理操作立即生效，不需要保存。',
  unblock: '只给网易云完全没有音源的歌兜底，默认关闭。',
}

// ---------------- building blocks ----------------

function AdminBrand() {
  return (
    <div className="flex items-center gap-3 px-1 lg:px-2.5">
      <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[linear-gradient(135deg,#6D4BFF_0%,#FF4D7E_100%)] text-white shadow-[0_8px_24px_rgba(109,75,255,0.35)]">
        <Icon name="sliders" size={20} strokeWidth={2} />
      </div>
      <div className="flex flex-1 flex-col">
        <span className="num text-[19px] font-bold tracking-[0.01em]">Netease KTV</span>
        <span className="text-xs text-muted">后台管理</span>
      </div>
      <Link
        to="/"
        className="flex h-9 items-center gap-1.5 rounded-lg bg-white/6 px-3 text-sm whitespace-nowrap text-fg-2 hover:bg-white/10 lg:hidden"
      >
        点歌台
      </Link>
    </div>
  )
}

function ExternalNav({ to, icon, label }: { to: string; icon: IconName; label: string }) {
  return (
    <Link
      to={to}
      target="_blank"
      className="flex h-11 items-center gap-3 rounded-xl px-3 text-[15px] text-[#C8C8D0] hover:bg-white/5"
    >
      <Icon name={icon} size={19} />
      <span className="flex-1">{label}</span>
      <Icon name="top" size={15} className="rotate-45 text-faint" />
    </Link>
  )
}

type SetFn = <K extends keyof AdminSettings>(k: K, v: AdminSettings[K]) => void

const GB = 1024 ** 3
const gb = (bytes: number) => (bytes / GB).toFixed(bytes >= 10 * GB ? 0 : 1)
const kb = (bytes: number) =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`

// ---------------- 运行状态 ----------------

function useAdminStatus() {
  return useQuery({ queryKey: ['admin-status'], queryFn: api.adminStatus, refetchInterval: 5000, staleTime: 0 })
}

function duration(sec: number) {
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  if (d) return `${d} 天 ${h} 小时`
  if (h) return `${h} 小时 ${m} 分`
  return `${Math.max(1, m)} 分钟`
}

type Tone = 'ok' | 'warn' | 'bad' | 'idle'
const TONE_DOT: Record<Tone, string> = { ok: 'bg-ok-dot', warn: 'bg-warn-dot', bad: 'bg-accent', idle: 'bg-faint' }

function separatorState(s: AdminStatus['separator'] | undefined): { tone: Tone; text: string } {
  if (!s) return { tone: 'idle', text: '读取中' }
  if (!s.nodes) return { tone: 'warn', text: '未配置' }
  if (!s.online) return { tone: 'bad', text: '全部离线' }
  if (!s.ready) return { tone: 'warn', text: '模型准备中' }
  if (s.busyNodes > 0) return { tone: 'ok', text: `${s.busyNodes} 台工作中` }
  return { tone: 'ok', text: '空闲' }
}

function StatusTile({
  icon,
  label,
  tone,
  value,
  sub,
}: {
  icon: IconName
  label: string
  tone: Tone
  value: ReactNode
  sub?: ReactNode
}) {
  return (
    <div className="flex min-w-0 flex-col gap-3 rounded-2xl border border-white/7 bg-white/[0.025] p-4">
      <div className="flex items-center gap-2 text-xs text-subtle">
        <Icon name={icon} size={15} />
        {label}
        <span className={clsx('ml-auto h-2 w-2 rounded-full', TONE_DOT[tone])} />
      </div>
      <div className="truncate text-lg font-bold">{value}</div>
      {sub && <div className="min-h-[18px] truncate text-xs text-muted">{sub}</div>}
    </div>
  )
}

function Overview() {
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
          sub={account?.loggedIn ? (account.vipType ? '黑胶 VIP' : '普通账号') : '在点歌台左下角扫码登录'}
        />
        <StatusTile
          icon="database"
          label="缓存占用"
          tone={!cache.data ? 'idle' : ratio > 0.9 ? 'warn' : 'ok'}
          value={
            cache.data ? (
              <span className="num">
                {gb(used)} <span className="text-sm font-medium text-muted">/ {gb(limit)} GB</span>
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

function Info({ k, v }: { k: string; v: ReactNode }) {
  return (
    <>
      <dt className="text-muted">{k}</dt>
      <dd className="m-0 min-w-0 text-fg-2">{v ?? <span className="text-faint">—</span>}</dd>
    </>
  )
}

// ---------------- 音质与分离 ----------------

const LEVELS: { value: SoundLevel; label: string; note: string }[] = [
  { value: 'standard', label: '标准', note: '128k' },
  { value: 'higher', label: '较高', note: '192k' },
  { value: 'exhigh', label: '极高', note: '320k' },
  { value: 'lossless', label: '无损', note: 'FLAC' },
  { value: 'hires', label: 'Hi-Res', note: '' },
]

function AudioSection({ draft, set }: { draft: AdminSettings; set: SetFn }) {
  const preset = MODELS.some((m) => m.value === draft.separatorModel)
  const [custom, setCustom] = useState(!preset)
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

      <Card title="伴奏分离模型">
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
          karaoke 类模型只去掉主唱、保留和声，唱起来不空。换模型后，第一次分离会先下载模型文件。
        </p>
      </Card>
    </>
  )
}

// ---------------- 网络 ----------------

function isLocalHost(host: string) {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]'
}

function NetworkSection({ draft, set }: { draft: AdminSettings; set: SetFn }) {
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

// ---------------- 视频与缓存 ----------------

const RESOLUTIONS: MvResolution[] = [480, 720, 1080]

function StorageSection({ draft, set }: { draft: AdminSettings; set: SetFn }) {
  const qc = useQueryClient()
  const cache = useCacheInfo()
  const [confirming, setConfirming] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [clearingData, setClearingData] = useState(false)
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

  async function clearData() {
    setClearingData(true)
    try {
      await api.clearDataCache()
      await qc.invalidateQueries()
      toast('数据缓存已清除，列表会重新从网易云获取')
    } catch (e) {
      toast(errorText(e), 'error')
    } finally {
      setClearingData(false)
    }
  }

  return (
    <>
      <Card title="MV">
        <Row title="预载 MV" help="提前下载已点歌曲的 MV：播放更流畅，并能自动和歌曲对齐。">
          <Switch checked={draft.mvPreload ?? true} onChange={(v) => set('mvPreload', v)} label="预载 MV" />
        </Row>
        <Row stack title="MV 清晰度" help="清晰度越高越占空间，网络慢时建议 720P 或 480P。">
          <Segmented
            label="MV 清晰度"
            value={draft.mvResolution ?? 720}
            onChange={(v) => set('mvResolution', v)}
            options={RESOLUTIONS.map((r) => ({ value: r, label: <span className="num">{r}P</span> }))}
          />
        </Row>
      </Card>

      <Card title="音频、伴奏与 MV 缓存">
        <Row stack title="缓存上限" help="超出时自动清理最久没唱的歌；正在唱和已点的歌不会被清理。">
          <div className="flex items-center gap-4">
            <div className="flex-1">
              <Range label="缓存上限（GB）" min={1} max={500} value={limitGB} onChange={(n) => set('cacheLimitGB', n)} color="#8B7BFF" />
            </div>
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
        </Row>

        <div className="flex flex-col gap-3 rounded-2xl border border-white/8 bg-white/4 p-4">
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
              <div className="flex items-baseline justify-between gap-3">
                <span className="num text-xl font-bold">
                  {gb(used)} <span className="text-sm font-medium text-muted">/ {limitGB} GB</span>
                </span>
                <span className="num text-xs text-muted">{cache.data?.songs ?? 0} 首歌 · {cache.data?.mvs ?? 0} 个 MV</span>
              </div>
              <ProgressBar value={ratio} color={ratio > 0.9 ? '#FBBF24' : '#8B7BFF'} />
              <span className="num text-xs text-fg-2">
                音频与伴奏 {gb(cache.data?.audioBytes ?? 0)} GB · MV {gb(cache.data?.mvBytes ?? 0)} GB
              </span>
            </>
          )}
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
      </Card>

      <Card title="网易云数据缓存">
        <Row
          title="歌单、榜单、日推、搜索和歌词"
          help={
            <>
              列表和歌词先读缓存，加载更快；网易云接口出错时也先用缓存顶上。
              {cache.data && <span className="num"> 当前 {cache.data.dataEntries} 条 · {kb(cache.data.dataBytes)}。</span>}
            </>
          }
        >
          <button
            type="button"
            onClick={clearData}
            disabled={clearingData}
            className="flex h-9 shrink-0 items-center gap-1.5 rounded-lg bg-white/6 px-3 text-sm whitespace-nowrap text-fg-2 hover:bg-white/10 disabled:opacity-60"
          >
            {clearingData ? <Spinner size={13} /> : <Icon name="refresh" size={15} />}
            清除
          </button>
        </Row>
      </Card>
    </>
  )
}

// ---------------- 第三方音源 ----------------

function UnblockSection({ draft, set, options }: { draft: AdminSettings; set: SetFn; options: string[] }) {
  return (
    <>
      <Card>
        <Row title="启用第三方音源（unblock）" help="只对网易云没有音源的歌生效。">
          <Switch checked={draft.unblockEnabled} onChange={(v) => set('unblockEnabled', v)} label="启用第三方音源" />
        </Row>
        {draft.unblockEnabled && options.length > 0 && (
          <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
            <legend className="mb-2 text-sm text-fg-2">允许的音源（按顺序尝试）</legend>
            <div className="flex flex-wrap gap-2">
              {options.map((o) => {
                const on = draft.unblockSources.includes(o)
                return (
                  <label
                    key={o}
                    className={clsx(
                      'num inline-flex h-9 cursor-pointer items-center gap-2 rounded-full border px-3 text-sm',
                      on ? 'border-white/40 bg-white/10 text-fg' : 'border-white/10 text-muted',
                    )}
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
