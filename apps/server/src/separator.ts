/**
 * Separation cluster: any number of separator servers (the local container, other PCs on the LAN).
 *
 * Every job is shipped by upload: the input is POSTed to the node, the node works in its own
 * folder, and the results are downloaded into our media directory. So a node never needs our
 * /data volume, and the local container is just one more node (and optional).
 *
 * Scheduling (see `chooseSeparationNode`): a song goes to the node that will *finish* it first —
 * its measured speed (seconds of work per second of audio) times the song length, plus whatever
 * it is still busy with. A free CPU box therefore doesn't grab a song that the GPU box, busy for
 * another 20 s, would finish sooner. Pitch and MV-alignment jobs are light and go to the least
 * busy node.
 */
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import { config } from './config.js'
import { kv } from './db.js'
import type { SeparatorNodeView } from './shared/types.js'

export interface SeparatorNodeConfig {
  id: string
  name: string
  url: string
  /** Optional SEPARATOR_TOKEN of that node. */
  token?: string
  enabled: boolean
  /** Model for this node; empty = the global setting, or the node's own default. */
  model?: string
}

export interface SeparatorHealth {
  ok: boolean
  ready?: boolean
  stage?: string
  error?: string | null
  device?: string
  gpu?: boolean
  model?: string
  default_model?: string
  pending?: number
  queue?: number
  speed_factor?: number
  upload?: boolean
}

export interface SeparatorJob {
  id: string
  status: 'queued' | 'running' | 'done' | 'error'
  /** Stems are written; the job may still be extracting pitch. */
  stems_ready?: boolean
  progress: number
  outputs?: Record<string, string>
  error?: string
}

type JobMode = 'separate' | 'pitch' | 'align'

interface InFlight {
  jobId: string
  songId: number
  songName?: string
  mode: JobMode
  startedAt: number
  durationMs: number
  progress: number
}

interface NodeState {
  health: SeparatorHealth | null
  lastSeen: number
  lastError?: string
  jobs: Map<string, InFlight>
  done: number
  failed: number
}

const KEY = 'separatorNodes'
let nodes: SeparatorNodeConfig[] | null = null
const state = new Map<string, NodeState>()

function stateOf(id: string): NodeState {
  let s = state.get(id)
  if (!s) {
    s = { health: null, lastSeen: 0, jobs: new Map(), done: 0, failed: 0 }
    state.set(id, s)
  }
  return s
}

const normUrl = (url: string) => url.trim().replace(/\/+$/, '')

/** Configured nodes. First run: the local container from SEPARATOR_URL (if any). */
export function getNodes(): SeparatorNodeConfig[] {
  if (nodes) return nodes
  const saved = kv.get<SeparatorNodeConfig[]>(KEY)
  if (saved) nodes = saved
  else {
    nodes = config.separatorUrl ? [{ id: 'local', name: '本机', url: config.separatorUrl, enabled: true }] : []
    kv.set(KEY, nodes)
  }
  return nodes
}

function saveNodes(next: SeparatorNodeConfig[]): void {
  nodes = next
  kv.set(KEY, next)
}

export function addNode(input: Omit<SeparatorNodeConfig, 'id'>): SeparatorNodeConfig {
  const node: SeparatorNodeConfig = { ...input, url: normUrl(input.url), id: randomUUID().slice(0, 8) }
  saveNodes([...getNodes(), node])
  return node
}

export function updateNode(id: string, patch: Partial<Omit<SeparatorNodeConfig, 'id'>>): SeparatorNodeConfig | null {
  let found: SeparatorNodeConfig | null = null
  saveNodes(
    getNodes().map((n) => {
      if (n.id !== id) return n
      found = { ...n, ...patch, ...(patch.url !== undefined ? { url: normUrl(patch.url) } : {}) }
      // An empty token in the patch means "remove it"; undefined keeps the old one.
      if (patch.token === '') delete found.token
      return found
    }),
  )
  if (found) state.delete(id) // fresh status for the new address / token
  return found
}

export function removeNode(id: string): boolean {
  const before = getNodes().length
  saveNodes(getNodes().filter((n) => n.id !== id))
  state.delete(id)
  return getNodes().length < before
}

// ---------- HTTP ----------

class NodeError extends Error {
  /** True when the node could not be reached at all (worth retrying on another node). */
  unreachable: boolean
  constructor(message: string, unreachable: boolean) {
    super(message)
    this.unreachable = unreachable
  }
}

function headers(node: Pick<SeparatorNodeConfig, 'token'>, extra?: Record<string, string>): Record<string, string> {
  return { ...(node.token ? { authorization: `Bearer ${node.token}` } : {}), ...extra }
}

async function call<T>(
  node: Pick<SeparatorNodeConfig, 'url' | 'token'>,
  method: string,
  pathname: string,
  body?: unknown,
  timeoutMs = 10_000,
): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${node.url}${pathname}`, {
      method,
      headers: headers(node, body ? { 'content-type': 'application/json' } : undefined),
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    const timeout = (err as Error).name === 'TimeoutError'
    throw new NodeError(timeout ? '连接分离服务器超时' : `无法连接分离服务器：${(err as Error).message}`, true)
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    if (res.status === 401) throw new NodeError('分离服务器令牌不正确', false)
    throw new NodeError(`separator ${method} ${pathname} -> ${res.status} ${text.slice(0, 200)}`, res.status >= 500)
  }
  return (await res.json()) as T
}

async function health(node: Pick<SeparatorNodeConfig, 'url' | 'token'>, timeoutMs = 3000): Promise<SeparatorHealth> {
  return call<SeparatorHealth>(node, 'GET', '/health', undefined, timeoutMs)
}

/** Connection test for the admin panel (also checks the token against the job API). */
export async function testNode(url: string, token?: string): Promise<{ ok: boolean; message: string; health?: SeparatorHealth }> {
  const node = { url: normUrl(url), token: token || undefined }
  if (!/^https?:\/\/[^\s/]+/i.test(node.url)) return { ok: false, message: '地址要以 http:// 或 https:// 开头' }
  try {
    const h = await health(node, 5000)
    if (!h.upload) return { ok: false, message: '这台分离服务器版本太旧，请用本项目的 separator 镜像重新部署', health: h }
    // A job id that cannot exist: 404 = token accepted, 401 = wrong token.
    try {
      await call(node, 'GET', '/jobs/0', undefined, 5000)
    } catch (err) {
      if (err instanceof NodeError && /令牌/.test(err.message)) return { ok: false, message: err.message, health: h }
    }
    return { ok: true, message: '连接成功', health: h }
  } catch (err) {
    return { ok: false, message: (err as Error).message }
  }
}

async function upload(node: SeparatorNodeConfig, file: string): Promise<string> {
  const ext = path.extname(file).slice(1).toLowerCase() || 'bin'
  const size = fs.statSync(file).size
  let res: Response
  try {
    const init = {
      method: 'POST',
      headers: headers(node, { 'content-type': 'application/octet-stream', 'content-length': String(size) }),
      body: Readable.toWeb(fs.createReadStream(file)),
      // Node's fetch needs this for streamed request bodies.
      duplex: 'half',
      signal: AbortSignal.timeout(10 * 60_000),
    }
    res = await fetch(`${node.url}/files?ext=${encodeURIComponent(ext)}`, init as unknown as RequestInit)
  } catch (err) {
    throw new NodeError(`上传到分离服务器失败：${(err as Error).message}`, true)
  }
  if (!res.ok) throw new NodeError(`上传失败（${res.status}）`, res.status >= 500)
  return ((await res.json()) as { file: string }).file
}

async function downloadOutput(node: SeparatorNodeConfig, jobId: string, name: string, dest: string): Promise<void> {
  const res = await fetch(`${node.url}/jobs/${jobId}/files/${name}`, {
    headers: headers(node),
    signal: AbortSignal.timeout(10 * 60_000),
  }).catch((err: Error) => {
    throw new NodeError(`下载结果失败：${err.message}`, true)
  })
  if (!res.ok || !res.body) throw new NodeError(`下载 ${name} 失败（${res.status}）`, res.status >= 500)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  const tmp = `${dest}.part`
  await pipeline(Readable.fromWeb(res.body as unknown as WebReadableStream), fs.createWriteStream(tmp))
  fs.renameSync(tmp, dest)
}

function dropJob(node: SeparatorNodeConfig, jobId: string): void {
  void call(node, 'DELETE', `/jobs/${jobId}`).catch(() => {})
}

/**
 * Poll once a second until `done(job)` or the job errors. A node that stays unreachable for
 * `maxFailures` seconds in a row fails the job with `unreachable` set.
 */
async function pollJob(
  node: SeparatorNodeConfig,
  id: string,
  done: (job: SeparatorJob) => boolean,
  onTick?: (job: SeparatorJob) => void,
  maxFailures = 60,
): Promise<SeparatorJob> {
  let failures = 0
  for (;;) {
    await new Promise((r) => setTimeout(r, 1000))
    let job: SeparatorJob
    try {
      job = await call<SeparatorJob>(node, 'GET', `/jobs/${encodeURIComponent(id)}`)
      failures = 0
    } catch (err) {
      // The node restarted and forgot the job, or it is gone: give up on it.
      if (err instanceof NodeError && !err.unreachable) throw err
      if (++failures > maxFailures) throw err
      continue
    }
    if (job.status === 'error') throw new NodeError(job.error || '分离失败', false)
    onTick?.(job)
    if (done(job)) return job
  }
}

// ---------- status ----------

const isUp = (n: SeparatorNodeConfig) => {
  const h = stateOf(n.id).health
  return n.enabled && !!h?.ok && !!h.upload
}
const isReady = (n: SeparatorNodeConfig) => isUp(n) && stateOf(n.id).health?.ready !== false

/** Refresh every enabled node's health (every 5 s from the pipeline). */
export async function pollNodes(): Promise<void> {
  await Promise.all(
    getNodes().map(async (n) => {
      const s = stateOf(n.id)
      if (!n.enabled) {
        s.health = null
        return
      }
      try {
        s.health = await health(n)
        s.lastSeen = Date.now()
        s.lastError = s.health.upload ? undefined : '版本太旧，不支持上传模式，请更新该服务器的 separator 镜像'
      } catch (err) {
        s.health = null
        s.lastError = (err as Error).message
      }
    }),
  )
}

/** Speed in seconds of work per second of audio (lower = faster). */
function speedOf(n: SeparatorNodeConfig): number {
  const h = stateOf(n.id).health
  return h?.speed_factor ?? (h?.gpu ? 0.35 : 2)
}

function separations(n: SeparatorNodeConfig): InFlight[] {
  return [...stateOf(n.id).jobs.values()].filter((j) => j.mode === 'separate')
}

/** Seconds until the node is free for another separation (its queue, ours or anyone else's). */
function busyFor(n: SeparatorNodeConfig): number {
  const now = Date.now()
  const ours = separations(n)
  let sec = 0
  for (const j of ours) {
    const expected = Math.max(5, (j.durationMs / 1000) * speedOf(n))
    sec += Math.max(2, expected - (now - j.startedAt) / 1000)
  }
  // Jobs on that node we did not send (another host sharing it): assume a 4-minute song each.
  const foreign = Math.max(0, (stateOf(n.id).health?.queue ?? 0) - ours.length)
  sec += foreign * 240 * speedOf(n)
  return sec
}

/**
 * Pick the node that finishes this song soonest. `wait` = that node is still busy, so the caller
 * should hold the song back rather than give it to a slower free node. null = no node can take it.
 */
export function chooseSeparationNode(durationMs: number): { node: SeparatorNodeConfig; wait: boolean } | null {
  const ready = getNodes().filter(isReady)
  if (!ready.length) return null
  const work = Math.max(30, durationMs / 1000)
  let best: { node: SeparatorNodeConfig; eta: number; busy: boolean } | null = null
  for (const n of ready) {
    const busy = busyFor(n)
    const eta = busy + work * speedOf(n)
    if (!best || eta < best.eta - 0.5) best = { node: n, eta, busy: busy > 0 }
  }
  return best && { node: best.node, wait: best.busy }
}

/** Least busy online node for the light jobs (pitch extraction, MV alignment). */
function chooseAuxNode(): SeparatorNodeConfig | null {
  const up = getNodes().filter(isUp)
  if (!up.length) return null
  return up.reduce((a, b) => (stateOf(a.id).jobs.size <= stateOf(b.id).jobs.size ? a : b))
}

export function clusterOnline(): boolean {
  return getNodes().some(isUp)
}

export function hasNodes(): boolean {
  return getNodes().some((n) => n.enabled)
}

/** One-line summary for the desk / TV status chip. */
export function clusterSummary(): { online: boolean; ready: boolean; device?: string; model?: string; nodes: number; onlineNodes: number } {
  const enabled = getNodes().filter((n) => n.enabled)
  const up = enabled.filter(isUp)
  const fastest = [...up].sort((a, b) => speedOf(a) - speedOf(b))[0]
  const h = fastest ? stateOf(fastest.id).health : null
  return {
    online: up.length > 0,
    ready: up.some(isReady),
    device: up.length > 1 ? `${up.length} 台分离服务器` : h?.device,
    model: h?.model,
    nodes: enabled.length,
    onlineNodes: up.length,
  }
}

export function nodeViews(): SeparatorNodeView[] {
  return getNodes().map((n) => {
    const s = stateOf(n.id)
    const h = s.health
    return {
      id: n.id,
      name: n.name,
      url: n.url,
      enabled: n.enabled,
      hasToken: !!n.token,
      model: n.model ?? '',
      online: isUp(n),
      reachable: !!h?.ok,
      ready: isReady(n),
      stage: h?.stage,
      error: h?.error ?? s.lastError ?? undefined,
      device: h?.device,
      gpu: !!h?.gpu,
      activeModel: h?.model,
      queue: h?.queue ?? 0,
      speedFactor: h?.speed_factor,
      jobs: [...s.jobs.values()].map((j) => ({
        songId: j.songId,
        songName: j.songName,
        mode: j.mode,
        startedAt: j.startedAt,
        progress: j.progress,
      })),
      done: s.done,
      failed: s.failed,
      lastSeen: s.lastSeen,
    }
  })
}

// ---------- jobs ----------

export { NodeError }

async function runJob<T>(
  node: SeparatorNodeConfig,
  meta: { songId: number; songName?: string; mode: JobMode; durationMs: number },
  body: Record<string, unknown>,
  inputs: string[],
  work: (jobId: string, track: (j: SeparatorJob) => void) => Promise<T>,
): Promise<T> {
  const s = stateOf(node.id)
  const slot = randomUUID()
  // Reserve the slot before uploading so the scheduler counts it right away.
  const entry: InFlight = { jobId: slot, ...meta, startedAt: Date.now(), progress: 0 }
  s.jobs.set(slot, entry)
  try {
    const [input, input2] = await Promise.all(inputs.map((f) => upload(node, f)))
    const { id } = await call<{ id: string }>(node, 'POST', '/jobs', {
      ...body,
      song_id: meta.songId,
      duration_ms: meta.durationMs,
      input_file: input,
      input2_file: input2,
      mode: meta.mode,
    })
    entry.jobId = id
    entry.startedAt = Date.now()
    const result = await work(id, (j) => (entry.progress = j.progress ?? 0))
    s.done++
    return result
  } catch (err) {
    s.failed++
    s.lastError = (err as Error).message
    throw err
  } finally {
    s.jobs.delete(slot)
  }
}

const modelFor = (node: SeparatorNodeConfig, globalModel: string) => node.model || globalModel || undefined

/**
 * Separate a song on `node`: upload the original, wait for the stems, download them into
 * `outDir`. Resolves once the song is playable; `pitch` resolves later, when the reference
 * melody has been downloaded too (or failed).
 */
export async function separateOnNode(
  node: SeparatorNodeConfig,
  o: {
    songId: number
    songName?: string
    input: string
    outDir: string
    durationMs: number
    model: string
    onProgress: (p: number) => void
  },
): Promise<{ pitch: Promise<boolean> }> {
  let jobId = ''
  await runJob(
    node,
    { songId: o.songId, songName: o.songName, mode: 'separate', durationMs: o.durationMs },
    { model: modelFor(node, o.model) },
    [o.input],
    async (id, track) => {
      jobId = id
      try {
        await pollJob(node, id, (j) => j.status === 'done' || !!j.stems_ready, (j) => {
          track(j)
          o.onProgress(j.progress ?? 0)
        })
        // The song only counts as separated once both files are in place.
        await downloadOutput(node, id, 'vocals', path.join(o.outDir, 'vocals.flac'))
        await downloadOutput(node, id, 'instrumental', path.join(o.outDir, 'instrumental.flac'))
      } catch (err) {
        dropJob(node, id)
        throw err
      }
    },
  )
  const pitch = (async () => {
    try {
      const job = await pollJob(node, jobId, (j) => j.status === 'done', undefined, 300)
      if (!job.outputs?.pitch) return false
      await downloadOutput(node, jobId, 'pitch', path.join(o.outDir, 'pitch.json'))
      return true
    } catch (err) {
      console.warn(`[separator] pitch for ${o.songId} on ${node.name} failed:`, (err as Error).message)
      return false
    } finally {
      dropJob(node, jobId)
    }
  })()
  return { pitch }
}

/** Reference melody from an existing vocals stem (songs separated before scoring existed). */
export async function pitchOnCluster(songId: number, vocals: string, dest: string): Promise<boolean> {
  const node = chooseAuxNode()
  if (!node) return false
  return runJob(node, { songId, mode: 'pitch', durationMs: 0 }, {}, [vocals], async (id) => {
    try {
      const job = await pollJob(node, id, (j) => j.status === 'done', undefined, 300)
      if (!job.outputs?.pitch) return false
      await downloadOutput(node, id, 'pitch', dest)
      return true
    } finally {
      dropJob(node, id)
    }
  })
}

/** MV ↔ song offset (11 kHz mono WAVs). Returns the raw result written by the node. */
export async function alignOnCluster(
  songId: number,
  songWav: string,
  mvWav: string,
  durationMs: number,
  dest: string,
): Promise<{ offset: number; confidence: number }> {
  const node = chooseAuxNode()
  if (!node) throw new Error('没有在线的分离服务器')
  return runJob(node, { songId, mode: 'align', durationMs }, {}, [songWav, mvWav], async (id) => {
    try {
      await pollJob(node, id, (j) => j.status === 'done', undefined, 120)
      await downloadOutput(node, id, 'align', dest)
      return JSON.parse(fs.readFileSync(dest, 'utf8')) as { offset: number; confidence: number }
    } finally {
      dropJob(node, id)
    }
  })
}
