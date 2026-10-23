import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import type { SeparatorNodeView } from '@shared/types'
import { api, type SeparatorNodeInput } from '../../lib/api'
import { errorText, toast } from '../../lib/hooks'
import { Icon } from '../icons'
import { ProgressBar, Spinner, Switch } from '../ui'
import { Card, inputCls, MODELS } from './parts'

/**
 * 分离服务器: the separation cluster. Every node gets songs by upload, so it can be any machine
 * on the LAN running the separator image; the KTV host picks the node that finishes soonest.
 */
export function SeparatorsSection() {
  const q = useQuery({ queryKey: ['admin-separators'], queryFn: api.separators, refetchInterval: 3000, staleTime: 0 })
  const [editing, setEditing] = useState<SeparatorNodeView | 'new' | null>(null)
  const nodes = q.data?.nodes ?? []
  const online = nodes.filter((n) => n.enabled && n.online).length
  const enabled = nodes.filter((n) => n.enabled).length
  const busy = nodes.filter((n) => n.jobs.some((j) => j.mode === 'separate')).length

  return (
    <>
      <div className="grid grid-cols-3 gap-3">
        <Stat label="在线" value={`${online} / ${enabled}`} tone={!enabled ? 'idle' : online ? 'ok' : 'bad'} />
        <Stat label="工作中" value={String(busy)} tone={busy ? 'ok' : 'idle'} />
        <Stat
          label="已完成"
          value={String(nodes.reduce((n, x) => n + x.done, 0))}
          tone="idle"
          note={nodes.some((x) => x.failed) ? `失败 ${nodes.reduce((n, x) => n + x.failed, 0)}` : undefined}
        />
      </div>

      <Card
        title="服务器"
        action={
          editing !== 'new' && (
            <button
              type="button"
              onClick={() => setEditing('new')}
              className="flex h-9 items-center gap-1.5 rounded-lg bg-white/8 px-3 text-sm font-semibold whitespace-nowrap text-fg hover:bg-white/12"
            >
              <Icon name="plus" size={15} />
              添加服务器
            </button>
          )
        }
      >
        {editing === 'new' && <NodeForm onDone={() => setEditing(null)} />}
        {q.isLoading ? (
          <div className="flex justify-center py-8 text-muted">
            <Spinner />
          </div>
        ) : q.isError && !q.data ? (
          <div className="flex items-center justify-between gap-3 text-sm text-muted">
            {errorText(q.error)}
            <button type="button" onClick={() => q.refetch()} className="text-accent-soft hover:underline">
              重试
            </button>
          </div>
        ) : nodes.length === 0 && editing !== 'new' ? (
          <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-white/12 px-4 py-8 text-center">
            <Icon name="server" size={26} className="text-faint" />
            <span className="text-sm font-semibold">还没有分离服务器</span>
            <span className="text-xs leading-5 text-muted">没有分离服务器时，点的歌会直接播放原曲。</span>
          </div>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {nodes.map((n) =>
              editing !== 'new' && editing?.id === n.id ? (
                <li key={n.id}>
                  <NodeForm node={n} onDone={() => setEditing(null)} />
                </li>
              ) : (
                <li key={n.id}>
                  <NodeCard node={n} onEdit={() => setEditing(n)} />
                </li>
              ),
            )}
          </ul>
        )}
      </Card>

      <Card title="调度方式">
        <ul className="m-0 flex list-none flex-col gap-2.5 p-0 text-[13px] leading-6 text-fg-2">
          <li className="flex gap-2.5">
            <Dot />
            每首歌交给<strong className="text-fg">预计最快完成</strong>的服务器：按它实测的处理速度乘以歌曲时长，再加上它手上还没做完的活。
          </li>
          <li className="flex gap-2.5">
            <Dot />
            快的服务器只差一点就空出来时，歌会等它，而不是交给空闲但慢很多的服务器。
          </li>
          <li className="flex gap-2.5">
            <Dot />
            几台服务器同时工作，已点列表里的歌按顺序分配；某台中途掉线，这首歌会自动换一台重新分离。
          </li>
          <li className="flex gap-2.5">
            <Dot />
            音高提取、MV 对齐这类轻任务交给当前最闲的服务器。
          </li>
        </ul>
      </Card>

      <DeployHelp />
    </>
  )
}

function Dot() {
  return <span className="mt-[9px] h-1.5 w-1.5 shrink-0 rounded-full bg-[#8B7BFF]" />
}

type Tone = 'ok' | 'bad' | 'warn' | 'idle'
const TONE: Record<Tone, string> = { ok: 'bg-ok-dot', bad: 'bg-accent', warn: 'bg-warn-dot', idle: 'bg-faint' }

function Stat({ label, value, tone, note }: { label: string; value: string; tone: Tone; note?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5 rounded-2xl border border-white/7 bg-white/[0.025] p-3.5 sm:p-4">
      <span className="flex items-center gap-2 text-xs text-subtle">
        <span className={clsx('h-1.5 w-1.5 rounded-full', TONE[tone])} />
        {label}
      </span>
      <span className="num truncate text-xl font-bold">{value}</span>
      {note && <span className="text-xs text-accent-soft">{note}</span>}
    </div>
  )
}

function nodeState(n: SeparatorNodeView): { tone: Tone; text: string } {
  if (!n.enabled) return { tone: 'idle', text: '已停用' }
  if (!n.reachable) return { tone: 'bad', text: '离线' }
  if (!n.online) return { tone: 'bad', text: '版本太旧' }
  if (n.stage === 'error') return { tone: 'bad', text: '模型加载失败' }
  if (!n.ready) return { tone: 'warn', text: '模型准备中' }
  if (n.jobs.some((j) => j.mode === 'separate')) return { tone: 'ok', text: '工作中' }
  return { tone: 'ok', text: '空闲' }
}

const JOB_LABEL = { separate: '分离', pitch: '提取音高', align: 'MV 对齐' } as const

function NodeCard({ node: n, onEdit }: { node: SeparatorNodeView; onEdit: () => void }) {
  const qc = useQueryClient()
  const st = nodeState(n)
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)

  async function toggle(enabled: boolean) {
    setBusy(true)
    try {
      await api.updateSeparator(n.id, { enabled })
      await qc.invalidateQueries({ queryKey: ['admin-separators'] })
    } catch (e) {
      toast(errorText(e), 'error')
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    setBusy(true)
    try {
      await api.removeSeparator(n.id)
      await qc.invalidateQueries({ queryKey: ['admin-separators'] })
      toast(`已移除 ${n.name}`)
    } catch (e) {
      toast(errorText(e), 'error')
      setBusy(false)
    }
  }

  const speed = n.speedFactor !== undefined ? speedText(n.speedFactor) : null

  return (
    <div
      className={clsx(
        'flex flex-col gap-3 rounded-2xl border p-4 transition-colors',
        n.enabled ? 'border-white/8 bg-white/[0.03]' : 'border-white/6 bg-transparent opacity-70',
      )}
    >
      <div className="flex items-start gap-3">
        <span className={clsx('mt-[7px] h-2.5 w-2.5 shrink-0 rounded-full', TONE[st.tone])} />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-[15px] font-semibold">{n.name}</span>
            <span className="text-xs text-muted">{st.text}</span>
            {n.reachable && (
              <span
                className={clsx(
                  'rounded-md px-1.5 py-px text-[11px] font-semibold',
                  n.gpu ? 'bg-[rgba(110,231,160,0.14)] text-ok' : 'bg-white/8 text-fg-2',
                )}
              >
                {n.gpu ? 'GPU' : 'CPU'}
              </span>
            )}
            {n.hasToken && <Icon name="lock" size={13} className="text-subtle" aria-label="已设置令牌" />}
          </div>
          <span className="num truncate text-xs text-subtle">{n.url}</span>
        </div>
        <Switch checked={n.enabled} onChange={(v) => !busy && void toggle(v)} label={`启用 ${n.name}`} />
      </div>

      {n.reachable && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 pl-[22px] text-xs text-muted">
          {n.device && <span className="num">{n.device}</span>}
          {n.activeModel && <span className="num max-w-full truncate">{shortModel(n.activeModel)}</span>}
          {speed && <span>{speed}</span>}
          <span className="num">
            完成 {n.done}
            {n.failed > 0 && <span className="text-accent-soft"> · 失败 {n.failed}</span>}
          </span>
          {n.model && <span className="text-[#8B7BFF]">固定模型</span>}
        </div>
      )}

      {n.jobs.length > 0 && (
        <ul className="m-0 ml-[22px] flex list-none flex-col gap-2 rounded-xl bg-white/4 p-3">
          {n.jobs.map((j, i) => (
            <li key={i} className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2 text-xs">
                <Spinner size={12} />
                <span className="text-muted">{JOB_LABEL[j.mode]}</span>
                <span className="min-w-0 flex-1 truncate text-fg-2">{j.songName ?? `#${j.songId}`}</span>
                {j.mode === 'separate' && <span className="num text-muted">{Math.round(j.progress * 100)}%</span>}
              </div>
              {j.mode === 'separate' && <ProgressBar value={j.progress} color="#8B7BFF" />}
            </li>
          ))}
        </ul>
      )}

      {n.enabled && n.error && (
        <p className="m-0 ml-[22px] text-xs leading-5 break-all text-warn">{n.error}</p>
      )}

      <div className="flex justify-end gap-2">
        {confirm ? (
          <>
            <span className="mr-auto self-center pl-[22px] text-xs text-muted">
              {n.jobs.length ? '它手上的歌会交给其他服务器重做。' : '确定移除？'}
            </span>
            <button type="button" onClick={() => setConfirm(false)} className="h-9 rounded-lg px-3 text-sm text-muted hover:text-fg">
              取消
            </button>
            <button
              type="button"
              onClick={remove}
              disabled={busy}
              className="flex h-9 items-center gap-1.5 rounded-lg bg-[rgba(255,77,126,0.16)] px-3 text-sm font-semibold text-accent-soft disabled:opacity-60"
            >
              {busy && <Spinner size={13} />}
              确认移除
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={onEdit}
              className="flex h-9 items-center gap-1.5 rounded-lg bg-white/6 px-3 text-sm text-fg-2 hover:bg-white/10"
            >
              <Icon name="pen" size={14} />
              编辑
            </button>
            <button
              type="button"
              onClick={() => setConfirm(true)}
              className="flex h-9 items-center gap-1.5 rounded-lg px-3 text-sm text-muted hover:bg-white/6 hover:text-fg"
            >
              <Icon name="trash" size={14} />
              移除
            </button>
          </>
        )}
      </div>
    </div>
  )
}

function speedText(f: number) {
  // f = seconds of work per second of audio
  const perSong = f * 240
  const t = perSong < 90 ? `${Math.max(5, Math.round(perSong / 5) * 5)} 秒` : `${(perSong / 60).toFixed(perSong < 600 ? 1 : 0)} 分钟`
  return `4 分钟的歌约 ${t}`
}

function shortModel(m: string) {
  const preset = MODELS.find((x) => x.value === m)
  return preset ? preset.label : m.replace(/\.(ckpt|onnx|pth|yaml)$/, '')
}

// ---------------- add / edit ----------------

function NodeForm({ node, onDone }: { node?: SeparatorNodeView; onDone: () => void }) {
  const qc = useQueryClient()
  const [name, setName] = useState(node?.name ?? '')
  const [url, setUrl] = useState(node?.url ?? 'http://')
  const [token, setToken] = useState('')
  const [clearToken, setClearToken] = useState(false)
  const [model, setModel] = useState(node?.model ?? '')
  const [test, setTest] = useState<{ ok: boolean; message: string; detail?: string } | null>(null)
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)
  const customModel = !!model && !MODELS.some((m) => m.value === model)
  const [custom, setCustom] = useState(customModel)
  const urlOk = /^https?:\/\/[^\s/]+/i.test(url.trim())

  async function runTest() {
    setTesting(true)
    setTest(null)
    try {
      const r = await api.testSeparator({ url: url.trim(), token: token || undefined, id: clearToken ? undefined : node?.id })
      const h = r.health
      setTest({ ok: r.ok, message: r.message, detail: h?.device ? `${h.device}${h.model ? ' · ' + shortModel(h.model) : ''}` : undefined })
    } catch (e) {
      setTest({ ok: false, message: errorText(e) })
    } finally {
      setTesting(false)
    }
  }

  async function save() {
    if (!name.trim() || !urlOk) return
    setSaving(true)
    const body: SeparatorNodeInput = { name: name.trim(), url: url.trim(), model: custom || model ? model.trim() : '' }
    if (token) body.token = token
    else if (clearToken) body.token = ''
    try {
      if (node) await api.updateSeparator(node.id, body)
      else await api.addSeparator({ ...body, enabled: true })
      await qc.invalidateQueries({ queryKey: ['admin-separators'] })
      toast(node ? '已保存' : `已添加 ${body.name}`)
      onDone()
    } catch (e) {
      toast(errorText(e), 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col gap-4 rounded-2xl border border-[rgba(139,123,255,0.4)] bg-[rgba(109,75,255,0.07)] p-4">
      <span className="text-[15px] font-semibold">{node ? `编辑 ${node.name}` : '添加分离服务器'}</span>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1.6fr]">
        <label className="flex flex-col gap-1.5">
          <span className="text-xs text-muted">名称</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="书房的台式机" maxLength={40} className={inputCls} />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs text-muted">地址</span>
          <input
            value={url}
            onChange={(e) => {
              setUrl(e.target.value)
              setTest(null)
            }}
            placeholder="http://192.168.1.20:9000"
            className={clsx(inputCls, 'num')}
            inputMode="url"
            autoCapitalize="off"
            spellCheck={false}
          />
        </label>
      </div>
      <label className="flex flex-col gap-1.5">
        <span className="text-xs text-muted">令牌（那台服务器设置了 SEPARATOR_TOKEN 才需要）</span>
        <input
          type="password"
          value={token}
          onChange={(e) => {
            setToken(e.target.value)
            setClearToken(false)
            setTest(null)
          }}
          placeholder={node?.hasToken && !clearToken ? '已设置，留空保持不变' : '可选'}
          autoComplete="new-password"
          className={clsx(inputCls, 'num')}
        />
        {node?.hasToken && !token && (
          <label className="flex items-center gap-2 text-xs text-muted">
            <input type="checkbox" checked={clearToken} onChange={(e) => setClearToken(e.target.checked)} className="accent-accent" />
            移除已保存的令牌
          </label>
        )}
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-xs text-muted">这台服务器用的模型</span>
        <select
          value={custom ? '__custom' : model}
          onChange={(e) => {
            if (e.target.value === '__custom') {
              setCustom(true)
            } else {
              setCustom(false)
              setModel(e.target.value)
            }
          }}
          className={clsx(inputCls, 'appearance-none')}
        >
          <option value="" className="bg-panel">
            跟随“音质与分离”里的设置
          </option>
          {MODELS.filter((m) => m.value).map((m) => (
            <option key={m.value} value={m.value} className="bg-panel">
              {m.label}（{m.note}）
            </option>
          ))}
          <option value="__custom" className="bg-panel">
            自定义…
          </option>
        </select>
        {custom && (
          <input
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="模型文件名，例如 UVR-MDX-NET-Voc_FT.onnx"
            className={clsx(inputCls, 'num')}
          />
        )}
        <span className="text-xs leading-5 text-muted">只有 CPU 的服务器建议固定用 MDX-Net，RoFormer 在 CPU 上很慢。</span>
      </label>

      {test && (
        <div
          role="status"
          className={clsx(
            'flex items-start gap-2 rounded-xl px-3 py-2.5 text-xs leading-5',
            test.ok ? 'bg-[rgba(110,231,160,0.1)] text-ok' : 'bg-[rgba(255,77,126,0.1)] text-accent-soft',
          )}
        >
          <Icon name={test.ok ? 'check' : 'alert'} size={15} className="mt-0.5 shrink-0" />
          <span className="min-w-0 break-all">
            {test.message}
            {test.detail && <span className="num text-fg-2"> · {test.detail}</span>}
          </span>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-end gap-2">
        <button
          type="button"
          onClick={runTest}
          disabled={!urlOk || testing}
          className="mr-auto flex h-10 items-center gap-1.5 rounded-xl bg-white/6 px-3.5 text-sm whitespace-nowrap text-fg-2 hover:bg-white/10 disabled:opacity-50"
        >
          {testing ? <Spinner size={14} /> : <Icon name="wave" size={15} />}
          测试连接
        </button>
        <button type="button" onClick={onDone} className="h-10 rounded-xl px-3.5 text-sm text-muted hover:text-fg">
          取消
        </button>
        <button
          type="button"
          onClick={save}
          disabled={!name.trim() || !urlOk || saving}
          className="flex h-10 items-center gap-2 rounded-xl bg-accent px-4 text-sm font-bold whitespace-nowrap text-accent-ink disabled:opacity-50"
        >
          {saving && <Spinner size={14} />}
          {node ? '保存' : '添加'}
        </button>
      </div>
    </div>
  )
}

// ---------------- deploy help ----------------

function DeployHelp() {
  const [open, setOpen] = useState(false)
  return (
    <Card>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex items-center justify-between gap-3 text-left"
      >
        <span className="flex flex-col gap-1">
          <span className="text-[15px] font-semibold">在另一台电脑上部署分离服务器</span>
          <span className="text-xs text-muted">有 NVIDIA 显卡的电脑最合适；只要能和本机互相访问就行</span>
        </span>
        <Icon name="chevronLeft" size={18} className={clsx('shrink-0 text-muted transition-transform', open ? 'rotate-90' : '-rotate-90')} />
      </button>
      {open && (
        <ol className="m-0 flex flex-col gap-3 pl-5 text-[13px] leading-6 text-fg-2">
          <li>在那台电脑上装好 Docker，并拷贝（或 git clone）本项目。</li>
          <li>
            运行 <Code>start-separator.cmd</Code>（Windows）或 <Code>./start-separator.sh</Code>（Linux / macOS）。脚本会自动选择 GPU
            或 CPU、下载模型，并打印出这台服务器的地址和令牌。
          </li>
          <li>
            回到这里点“添加服务器”，填入地址（例如 <Code>http://192.168.1.20:9000</Code>）和令牌，先“测试连接”再添加。
          </li>
          <li>那台电脑的防火墙需要放行 9000 端口。</li>
          <li>
            不想在本机运行分离服务：在本项目的 <Code>.env</Code> 里设置 <Code>KTV_SEPARATOR=off</Code>，再运行启动脚本。
          </li>
        </ol>
      )}
    </Card>
  )
}

function Code({ children }: { children: string }) {
  return <code className="num rounded-md bg-white/8 px-1.5 py-0.5 text-[12px] text-fg">{children}</code>
}
