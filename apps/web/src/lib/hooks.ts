import { useCallback, useEffect, useMemo, useState } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { create } from 'zustand'
import type { QueuePosition, Song } from '@shared/types'
import { useApp } from '../store/app'
import { api, ApiError, getToken, isRetryable } from './api'
import { setPreviewErrorHandler, stopPreviewFor } from './preview'
import { currentNickname } from './nickname'
import { deriveStatus, type SongStatus } from './format'

export function useDebounced<T>(value: T, ms = 250) {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return v
}

/** Returns a function that derives the display status of any song from live state. */
export function useStatusOf() {
  const tracks = useApp((s) => s.state.tracks)
  const queue = useApp((s) => s.state.queue)
  const currentId = useApp((s) => s.state.player.current?.song.id)
  const queued = useMemo(() => new Set(queue.map((q) => q.song.id)), [queue])
  return useCallback(
    (song: Song): SongStatus & { inQueue: boolean; isCurrent: boolean } => {
      const inQueue = queued.has(song.id)
      return { ...deriveStatus(song, tracks[song.id], inQueue), inQueue, isCurrent: currentId === song.id }
    },
    [tracks, queued, currentId],
  )
}

// ---------- Toasts ----------

export interface ToastAction {
  label: string
  run: () => void
}
interface Toast {
  id: number
  text: string
  tone: 'ok' | 'error'
  action?: ToastAction
}
interface ToastStore {
  toasts: Toast[]
  push: (text: string, tone?: Toast['tone'], action?: ToastAction) => void
  dismiss: (id: number) => void
}
let toastId = 0
export const useToasts = create<ToastStore>((set) => ({
  toasts: [],
  push: (text, tone = 'ok', action) => {
    const id = ++toastId
    set((s) => ({ toasts: [...s.toasts.slice(-3), { id, text, tone, action }] }))
    // Toasts with an action (e.g. 重试) stay long enough to be tapped.
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), action ? 7000 : 2600)
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}))
export const toast = (text: string, tone?: Toast['tone'], action?: ToastAction) =>
  useToasts.getState().push(text, tone, action)

setPreviewErrorHandler((msg) => toast(msg, 'error'))

export function errorText(e: unknown) {
  if (e instanceof ApiError) {
    if (e.status === 409) return e.message || '这首歌需要会员，无法点歌'
    if (e.status === 0) return e.message || '网络连接失败'
    return e.message || `请求失败（${e.status}）`
  }
  return e instanceof Error ? e.message : '请求失败'
}

// ---------- in-flight mutations ----------

/** Keys of requests currently in flight, so their buttons can be disabled. */
export const usePending = create<{ keys: Set<string> }>(() => ({ keys: new Set() }))
const setPending = (key: string, on: boolean) =>
  usePending.setState((s) => {
    const keys = new Set(s.keys)
    if (on) keys.add(key)
    else keys.delete(key)
    return { keys }
  })
export const useIsPending = (key: string) => usePending((s) => s.keys.has(key))

/**
 * Run a mutation with feedback: success toast, and on a network / server failure an error
 * toast with a 重试 action that resends the same request. Concurrent runs of the same key
 * are ignored (the button is disabled meanwhile).
 */
export async function runAction<T>(
  key: string,
  fn: () => Promise<T>,
  okText?: string | ((r: T) => string),
): Promise<T | undefined> {
  if (usePending.getState().keys.has(key)) return undefined
  setPending(key, true)
  try {
    const r = await fn()
    if (okText) toast(typeof okText === 'function' ? okText(r) : okText)
    return r
  } catch (e) {
    toast(
      errorText(e),
      'error',
      isRetryable(e) ? { label: '重试', run: () => void runAction(key, fn, okText) } : undefined,
    )
    return undefined
  } finally {
    setPending(key, false)
  }
}

export const enqueueKey = (songId: number, position: QueuePosition = 'end') => `enqueue:${songId}:${position}`

/** 点歌 / 插播 with feedback toasts and retry. */
export function useEnqueue() {
  return useCallback(async (song: Song, position: QueuePosition = 'end') => {
    stopPreviewFor(song.id)
    await runAction(
      enqueueKey(song.id, position),
      () => api.enqueue(song.id, position, currentNickname()),
      position === 'next' ? `已插播：${song.name}` : `已点：${song.name}`,
    )
  }, [])
}

/** Shuffle the whole queue (the current song keeps playing). */
export async function shuffleQueue(count: number) {
  await runAction('queue:shuffle', () => api.queueShuffle(), `已随机打乱 ${count} 首`)
}

export function useSettings() {
  return useQuery({ queryKey: ['settings'], queryFn: api.settings, staleTime: 60_000 })
}

/** 点歌记录, refetched live whenever anyone queues a song. */
export function useHistory(enabled = true) {
  const version = useApp((s) => s.historyVersion)
  return useQuery({ queryKey: ['history', version], queryFn: api.history, enabled, placeholderData: keepPreviousData })
}

export function useCacheInfo(enabled = true) {
  return useQuery({ queryKey: ['cache'], queryFn: api.cache, enabled, staleTime: 5_000 })
}

export function useAccount() {
  return useQuery({ queryKey: ['account'], queryFn: api.account, staleTime: 60_000 })
}

/** URL the phone should open (encoded into the QR code). */
export function useRemoteUrl() {
  const { data } = useSettings()
  return useMemo(() => {
    const base = (data?.publicUrl || window.location.origin).replace(/\/+$/, '')
    const token = getToken()
    return base + '/m' + (token ? '?token=' + encodeURIComponent(token) : '')
  }, [data?.publicUrl])
}

/** True when the page was opened through localhost, so a QR to it would not work from a phone. */
export function useIsLocalhostOrigin() {
  const { data } = useSettings()
  const host = window.location.hostname
  return !data?.publicUrl && (host === 'localhost' || host === '127.0.0.1' || host === '::1')
}
