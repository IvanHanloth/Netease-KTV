import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { Song } from '@shared/types'
import { api, mediaUrl } from '../lib/api'

const FADE_IN_S = 3
const FADE_OUT_S = 1.5
const TICK_MS = 50

/**
 * 待机音乐: while nothing is queued, the active TV plays the admin's idle playlist quietly
 * (accompaniment volume × the idle share), looping. Fades in when the idle page comes up and
 * out as soon as someone requests a song; the position is kept for next time.
 */
export function useIdleMusic(active: boolean, musicVolume: number): Song | null {
  const { data } = useQuery({ queryKey: ['idle-music'], queryFn: api.idleMusic, staleTime: 30_000, refetchInterval: 60_000 })
  const songs = data?.enabled ? data.songs : []
  const goal = active && songs.length ? Math.max(0, Math.min(1, musicVolume * (data?.volume ?? 0.5))) : 0
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [index, setIndex] = useState(0)
  const [song, setSong] = useState<Song | null>(null)
  const failures = useRef(0)
  const goalRef = useRef(goal)
  goalRef.current = goal

  if (!audioRef.current && typeof Audio !== 'undefined') {
    const a = new Audio()
    a.preload = 'auto'
    a.volume = 0
    audioRef.current = a
  }

  const current = songs.length ? songs[index % songs.length]! : null
  const wanted = active && current ? current : null

  // Load the song (after making sure the server has its audio) when it changes.
  useEffect(() => {
    const a = audioRef.current
    if (!a || !wanted) return
    if (a.dataset.song === String(wanted.id)) {
      if (a.paused) a.play().catch(() => {})
      return
    }
    let cancelled = false
    api
      .prepareIdleSong(wanted.id)
      .then(() => {
        if (cancelled) return
        a.dataset.song = String(wanted.id)
        a.src = mediaUrl(wanted.id, 'original')
        a.volume = 0
        return a.play()
      })
      .then(() => {
        failures.current = 0
        setSong(wanted)
      })
      .catch(() => {
        if (cancelled) return
        // Skip songs that can't be played; give up after a full round of failures.
        if (++failures.current < Math.max(1, songs.length)) window.setTimeout(() => setIndex((i) => i + 1), 1500)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted?.id])

  // Next song when one ends (the list loops).
  useEffect(() => {
    const a = audioRef.current
    if (!a) return
    const onEnded = () => {
      delete a.dataset.song
      setIndex((i) => i + 1)
    }
    a.addEventListener('ended', onEnded)
    return () => a.removeEventListener('ended', onEnded)
  }, [])

  // Volume follows the goal smoothly; at silence the audio pauses (and resumes where it was).
  useEffect(() => {
    const a = audioRef.current
    if (!a) return
    const t = window.setInterval(() => {
      const g = goalRef.current
      const step = (g > a.volume ? TICK_MS / 1000 / FADE_IN_S : TICK_MS / 1000 / FADE_OUT_S) * Math.max(g, 0.3)
      const v = Math.abs(g - a.volume) <= step ? g : a.volume + Math.sign(g - a.volume) * step
      a.volume = Math.max(0, Math.min(1, v))
      if (g === 0 && a.volume === 0 && !a.paused) a.pause()
      if (g > 0 && a.paused && a.dataset.song) a.play().catch(() => {})
    }, TICK_MS)
    return () => window.clearInterval(t)
  }, [])

  // Stop for good when the page goes away.
  useEffect(
    () => () => {
      audioRef.current?.pause()
    },
    [],
  )

  return active && song && wanted && song.id === wanted.id ? song : null
}
