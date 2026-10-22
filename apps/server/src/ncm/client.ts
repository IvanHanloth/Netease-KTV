import { createRequire } from 'node:module'
import { kv } from '../db.js'

const require = createRequire(import.meta.url)

export interface NcmResponse<B = any> {
  status: number
  body: B
  cookie: string[]
}
type NcmFn = (params: Record<string, unknown>) => Promise<NcmResponse>

// The library is CommonJS and exports one function per module file.
const api = require('@neteasecloudmusicapienhanced/api') as Record<string, NcmFn>

export class NcmError extends Error {
  constructor(
    message: string,
    public status = 502,
    public code?: number,
  ) {
    super(message)
  }
}

const COOKIE_KEY = 'ncm.cookie'

export function getCookie(): string {
  return kv.get<string>(COOKIE_KEY) ?? ''
}

export function setCookie(cookie: string): void {
  kv.set(COOKIE_KEY, cookie)
}

export function clearCookie(): void {
  kv.delete(COOKIE_KEY)
}

/**
 * Call one NetEase API module. The logged-in cookie is attached automatically.
 *
 * NOTE: never pass `unblock` here — third-party sources are handled only by
 * `resolveAudio()` in ../media/resolve.ts, which enforces the VIP guard.
 */
export async function call<B = any>(name: string, params: Record<string, unknown> = {}): Promise<NcmResponse<B>> {
  const fn = api[name]
  if (!fn) throw new NcmError(`Unknown NetEase API: ${name}`, 500)
  if ('unblock' in params) throw new NcmError('unblock must not be passed to NetEase API calls', 500)
  try {
    const res = await fn({ cookie: getCookie(), timestamp: Date.now(), ...params })
    return res as NcmResponse<B>
  } catch (err: any) {
    // The library rejects with the raw response object on API errors.
    const body = err?.body
    const msg = body?.message ?? body?.msg ?? err?.message ?? 'NetEase request failed'
    throw new NcmError(String(msg), err?.status && err.status >= 400 ? err.status : 502, body?.code)
  }
}

let initialized = false

/** Registers an anonymous device token and fetches encryption keys, like the library's own server does. */
export async function initNcm(): Promise<void> {
  if (initialized) return
  initialized = true
  try {
    const generateConfig = require('@neteasecloudmusicapienhanced/api/generateConfig.js') as () => Promise<void>
    await generateConfig()
  } catch (err) {
    console.warn('[ncm] generateConfig failed, continuing:', (err as Error).message)
  }
}
