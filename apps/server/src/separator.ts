import { config } from './config.js'

export interface SeparatorHealth {
  ok: boolean
  device?: string
  model?: string
  pending?: number
}

export interface SeparatorJob {
  id: string
  status: 'queued' | 'running' | 'done' | 'error'
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
}): Promise<{ id: string }> {
  return request('POST', '/jobs', {
    song_id: input.songId,
    input: input.input,
    output_dir: input.outputDir,
    duration_ms: input.durationMs,
    model: input.model || undefined,
  })
}

export function getJob(id: string): Promise<SeparatorJob> {
  return request('GET', `/jobs/${encodeURIComponent(id)}`)
}
