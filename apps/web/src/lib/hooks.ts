import { useCallback, useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { create } from 'zustand'
import type { Song } from '@shared/types'
import { useApp } from '../store/app'
import { api, ApiError, getToken } from './api'
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

interface Toast {
  id: number
  text: string
  tone: 'ok' | 'error'
}
interface ToastStore {
  toasts: Toast[]
  push: (text: string, tone?: Toast['tone']) => void
}
let toastId = 0
export const useToasts = create<ToastStore>((set) => ({
  toasts: [],
  push: (text, tone = 'ok') => {
    const id = ++toastId
    set((s) => ({ toasts: [...s.toasts.slice(-3), { id, text, tone }] }))
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 2600)
  },
}))
export const toast = (text: string, tone?: Toast['tone']) => useToasts.getState().push(text, tone)

export function errorText(e: unknown) {
  if (e instanceof ApiError) {
    if (e.status === 409) return e.message || '这首歌需要会员，无法点歌'
    return e.message || `请求失败（${e.status}）`
  }
  return e instanceof Error ? e.message : '请求失败'
}

/** 点歌 / 插播 with feedback toasts. */
export function useEnqueue() {
  return useCallback(async (song: Song, position: 'next' | 'end' = 'end') => {
    try {
      await api.enqueue(song.id, position)
      toast(position === 'next' ? `已插播：${song.name}` : `已点：${song.name}`)
    } catch (e) {
      toast(errorText(e), 'error')
    }
  }, [])
}

export function useSettings() {
  return useQuery({ queryKey: ['settings'], queryFn: api.settings, staleTime: 60_000 })
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
