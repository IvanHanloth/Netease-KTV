import { useSyncExternalStore } from 'react'
import type { PlaylistSummary } from '@shared/types'

/**
 * NetEase playlists imported temporarily on THIS device. They live only in this browser's
 * localStorage — never sent to the server state, other devices or the NetEase account.
 */
export interface ImportedPlaylist extends PlaylistSummary {
  importedAt: number
}

const KEY = 'ktv.importedPlaylists'
const MAX = 20
const listeners = new Set<() => void>()
let cache: ImportedPlaylist[] | null = null

function read(): ImportedPlaylist[] {
  if (cache) return cache
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '[]') as unknown
    cache = Array.isArray(raw) ? (raw.filter((p) => p && typeof p.id === 'number') as ImportedPlaylist[]) : []
  } catch {
    cache = []
  }
  return cache
}

function write(list: ImportedPlaylist[]) {
  cache = list
  try {
    localStorage.setItem(KEY, JSON.stringify(list))
  } catch {
    /* storage unavailable: keep in memory for this session */
  }
  listeners.forEach((l) => l())
}

export function getImportedPlaylists(): ImportedPlaylist[] {
  return read()
}

/** Add (or move to the top) a playlist; newest first, at most 20. */
export function addImportedPlaylist(p: PlaylistSummary) {
  const rest = read().filter((x) => x.id !== p.id)
  write([{ ...p, importedAt: Date.now() }, ...rest].slice(0, MAX))
}

export function removeImportedPlaylist(id: number) {
  write(read().filter((x) => x.id !== id))
}

export function subscribeImportedPlaylists(listener: () => void) {
  listeners.add(listener)
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY) {
      cache = null
      listener()
    }
  }
  window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(listener)
    window.removeEventListener('storage', onStorage)
  }
}

export function useImportedPlaylists(): ImportedPlaylist[] {
  return useSyncExternalStore(subscribeImportedPlaylists, getImportedPlaylists, getImportedPlaylists)
}
