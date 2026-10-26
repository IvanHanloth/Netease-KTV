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

/**
 * NetEase's neapi config (gorilla/algorithm/record) is a zstd frame whose final block is not
 * flagged as last. fzstd accepts that, but Node's built-in zstd, which the library uses on
 * Node 22.15+, fails with "unexpected end of file". So the key never gets cached and every start
 * logs a stack trace. Returns a copy with the flag set when the data ends exactly at the end of an
 * unflagged block, else null.
 */
export function terminateZstdFrame(buf: Buffer): Buffer | null {
  if (buf.length < 6 || buf.readUInt32LE(0) !== 0xfd2fb528) return null
  const fhd = buf[4]!
  const singleSegment = (fhd >> 5) & 1
  const dictIdBytes = [0, 1, 2, 4][fhd & 3]!
  const contentSizeBytes = [singleSegment, 2, 4, 8][fhd >> 6]!
  let pos = 5 + (singleSegment ? 0 : 1) + dictIdBytes + contentSizeBytes
  while (pos + 3 <= buf.length) {
    const header = buf.readUIntLE(pos, 3)
    if (header & 1) return null // already terminated: the problem is something else
    const type = (header >> 1) & 3
    const end = pos + 3 + (type === 1 ? 1 : header >> 3) // RLE blocks carry one byte
    if (end === buf.length) {
      const out = Buffer.from(buf)
      out[pos]! |= 1
      return out
    }
    pos = end
  }
  return null
}

function patchZstd(): void {
  const zstd = require('@neteasecloudmusicapienhanced/api/util/zstd.js') as { decompress: (b: Buffer) => Buffer }
  const decompress = zstd.decompress
  zstd.decompress = (input) => {
    try {
      return decompress(input)
    } catch (err) {
      const fixed = terminateZstdFrame(Buffer.from(input))
      if (!fixed) throw err
      return decompress(fixed)
    }
  }
}

let initialized = false

/** Registers an anonymous device token and fetches encryption keys, like the library's own server does. */
export async function initNcm(): Promise<void> {
  if (initialized) return
  initialized = true
  try {
    patchZstd()
  } catch (err) {
    console.warn('[ncm] zstd patch skipped:', (err as Error).message)
  }
  try {
    const generateConfig = require('@neteasecloudmusicapienhanced/api/generateConfig.js') as () => Promise<void>
    await generateConfig()
  } catch (err) {
    console.warn('[ncm] generateConfig failed, continuing:', (err as Error).message)
  }
}
