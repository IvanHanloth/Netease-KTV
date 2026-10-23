import { config } from './config.js'

export interface SeparatorHealth {
  ok: boolean
  ready?: boolean
  stage?: string
  device?: string
  model?: string
  pending?: number
}

export interface SeparatorJob {
  id: string
  status: 'queued' | 'running' | 'done' | 'error'
  /** Stems are written; the job may still be extracting pitch. */
  stems_ready?: boolean
  progress: number
  outputs?: { instrumental?: string; vocals?: string }
  error?: string
}

async function request<T>(method: string, pathname: string, body?: unknown, timeoutMs = 10_000): Promise<T> {
  const res = await fetch(`${config.separatorUrl}${pathname}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`separator ${method} ${pathname} -> ${res.status} ${text.slice(0, 200)}`)
  }
  return (await res.json()) as T
}

export async function separatorHealth(): Promise<SeparatorHealth | null> {
  try {
    return await request<SeparatorHealth>('GET', '/health', undefined, 3000)
  } catch {
    return null
  }
}

export function submitJob(input: {
  songId: number
  input: string
  outputDir: string
  durationMs: number
  model?: string
  /**
   * 'pitch' only extracts the reference melody from an existing vocals stem;
   * 'align' computes the MV offset from two WAVs (input = song, input2 = MV audio).
   */
  mode?: 'separate' | 'pitch' | 'align'
  input2?: string
}): Promise<{ id: string }> {
  return request('POST', '/jobs', {
    song_id: input.songId,
    input: input.input,
    input2: input.input2,
    output_dir: input.outputDir,
    duration_ms: input.durationMs,
    model: input.model || undefined,
    mode: input.mode ?? 'separate',
  })
}

export function getJob(id: string): Promise<SeparatorJob> {
  return request('GET', `/jobs/${encodeURIComponent(id)}`)
}

/**
 * Poll a job once a second until `done(job)` is true or the job errors.
 * Transient request failures are tolerated for up to `maxFailures` seconds in a row.
 */
export async function pollJob(
  id: string,
  done: (job: SeparatorJob) => boolean,
  onTick?: (job: SeparatorJob) => void,
  maxFailures = 90,
): Promise<SeparatorJob> {
  let failures = 0
  for (;;) {
    await new Promise((r) => setTimeout(r, 1000))
    let job: SeparatorJob
    try {
      job = await getJob(id)
      failures = 0
    } catch (err) {
      if (++failures > maxFailures) throw err
      continue
    }
    if (job.status === 'error') throw new Error(job.error || '分离失败')
    if (done(job)) return job
    onTick?.(job)
  }
}
