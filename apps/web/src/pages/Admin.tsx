import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import type { AdminSettings } from '@shared/types'
import { api } from '../lib/api'
import { errorText, toast, useSettings } from '../lib/hooks'
import { Icon, type IconName } from '../components/icons'
import { Spinner } from '../components/ui'
import { IdleSection } from '../components/admin/IdleSection'
import { SeparatorsSection } from '../components/admin/SeparatorsSection'
import { StorageSection } from '../components/admin/StorageSection'
import { Card } from '../components/admin/parts'
import { AudioSection, ModelSection } from '../components/admin/AudioSection'
import { NetworkSection } from '../components/admin/NetworkSection'
import { Overview } from '../components/admin/OverviewSection'
import { UnblockSection } from '../components/admin/UnblockSection'

type SectionId = 'overview' | 'separators' | 'audio' | 'idle' | 'network' | 'storage' | 'unblock'

const SECTIONS: { id: SectionId; label: string; icon: IconName; keys: (keyof AdminSettings)[] }[] = [
  { id: 'overview', label: '运行状态', icon: 'info', keys: [] },
  { id: 'separators', label: '分离服务器', icon: 'server', keys: ['separatorModel'] },
  { id: 'audio', label: '下载音质', icon: 'wave', keys: ['audioLevel'] },
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
  // A change saved elsewhere (another 后台 tab) flows into the draft for every key not edited here.
  const prevSaved = useRef<AdminSettings | null>(null)
  useEffect(() => {
    if (!saved) return
    const prev = prevSaved.current
    prevSaved.current = saved
    setDraft((d) => {
      if (!d || !prev) return d ?? saved
      const next = { ...d } as Record<string, unknown>
      for (const k of ADMIN_KEYS) if (same(d[k], prev[k])) next[k] = saved[k]
      return next as unknown as AdminSettings
    })
  }, [saved])

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
              <Overview go={go} />
            ) : section === 'separators' ? (
              <>
                <SeparatorsSection />
                {draft && <ModelSection draft={draft} set={set} />}
              </>
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
  audio: '影响新下载的歌曲；已经下载好的不会重新下载。',
  idle: '没人点歌时，主屏小声循环播放的音乐。',
  network: '手机扫码点歌用的地址。',
  storage: 'MV 下载和本地缓存的空间管理。清理操作立即生效，不需要保存。',
  unblock: '只给网易云完全没有音源的歌兜底，默认关闭。',
}

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
