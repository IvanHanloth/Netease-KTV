import { create } from 'zustand'
import type { Song } from '@shared/types'
import { previewUrl } from './api'

/**
 * 试听: plays a low-quality copy of a song on THIS device (phone / desk browser) so the
 * user can check it is the right song. It never touches the queue or the TV.
 * One preview at a time; stops after PREVIEW_SECONDS, when the page is hidden, or when
 * the song gets requested.
 */
export const PREVIEW_SECONDS = 30

interface PreviewState {
  songId: number | null
  loading: boolean
  /** 0..1 of PREVIEW_SECONDS */
  progress: number
}

export const usePreview = create<PreviewState>(() => ({ songId: null, loading: false, progress: 0 }))

let audio: HTMLAudioElement | null = null
let onError: ((msg: string) => void) | null = null

/** Lets the app show a toast when a preview can't be played (kept here to avoid a module cycle). */
export function setPreviewErrorHandler(fn: (msg: string) => void) {
  onError = fn
}

export function stopPreview() {
  if (audio) {
    audio.pause()
    audio.removeAttribute('src')
    audio.load()
    audio = null
  }
  usePreview.setState({ songId: null, loading: false, progress: 0 })
}

export function stopPreviewFor(songId: number) {
  if (usePreview.getState().songId === songId) stopPreview()
}

/**
 * Start / stop the preview of a song. Must be called directly from a click handler so
 * mobile browsers (iOS) allow playback.
 */
export function togglePreview(song: Pick<Song, 'id'>) {
  if (usePreview.getState().songId === song.id) {
    stopPreview()
    return
  }
  stopPreview()
  const el = new Audio()
  el.preload = 'auto'
  el.volume = 0.6
  el.src = previewUrl(song.id)
  audio = el
  usePreview.setState({ songId: song.id, loading: true, progress: 0 })
  const mine = () => audio === el
  el.addEventListener('playing', () => mine() && usePreview.setState({ loading: false }))
  el.addEventListener('waiting', () => mine() && usePreview.setState({ loading: true }))
  el.addEventListener('timeupdate', () => {
    if (!mine()) return
    const p = el.currentTime / PREVIEW_SECONDS
    if (p >= 1) stopPreview()
    else usePreview.setState({ progress: p })
  })
  el.addEventListener('ended', () => mine() && stopPreview())
  el.addEventListener('error', () => {
    if (!mine()) return
    stopPreview()
    onError?.('暂无试听')
  })
  el.play().catch((e: unknown) => {
    if (!mine()) return
    // NotAllowedError = autoplay policy; anything else = no audio for this song.
    stopPreview()
    onError?.(e instanceof DOMException && e.name === 'NotAllowedError' ? '浏览器阻止了播放，请再点一次' : '暂无试听')
  })
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') stopPreview()
  })
  window.addEventListener('pagehide', stopPreview)
}
