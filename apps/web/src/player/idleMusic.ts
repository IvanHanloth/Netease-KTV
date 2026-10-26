import { useCallback, useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { IdleSync, PlaybackSync, Song } from '@shared/types'
import { api, mediaUrl } from '../lib/api'
import { toServerTime } from '../lib/clock'
import { smoothSync, tvPosition } from '../lib/playbackSync'
import { sendMessage, useApp } from '../store/app'
import type { AudioEngine } from './engine'

/** Fade-in when the idle page comes up (≈3 s) and fade-out when a song is requested (≈1.5 s). */
const FADE_IN_TC = 1
const FADE_OUT_TC = 0.5
const FADE_OUT_MS = 1600
/** A 大屏 joining the 主屏's idle music mid-song. */
const JOIN_TC = 0.25

const keyOf = (id: number) => `idle|${id}`
const idOf = (key: string) => (key.startsWith('idle|') ? Number(key.slice(5)) : null)
const asPlayback = (s: IdleSync): PlaybackSync => ({ uid: keyOf(s.songId), epoch: 0, position: s.position, at: s.at, playing: s.playing })

export interface IdleMusicOptions {
  /** Plays the idle music (shares the page's AudioContext). */
  engine: AudioEngine
  /** This 大屏 is the 主屏: it picks the songs and reports; the others follow its reports. */
  main: boolean
  /** This screen may make sound (the 主屏 once started, another 大屏 once unmuted). */
  audible: boolean
  /** The idle page is up (nothing playing). */
  active: boolean
  /** Level (0..1): the 待机音乐 volume times this screen's own volume. */
  volume: number
}

/**
 * 待机音乐: while nothing is queued the 主屏 plays the admin's idle playlist, looping over the
 * list forever (a one-song list repeats that song). It fades in when the idle page comes up and
 * out as soon as someone requests a song; the position is kept for next time.
 *
 * Every 大屏 shows the same thing: the 主屏 reports which song it plays and where (like song
 * playback), the other 大屏 show that song and, once unmuted, play it in step. A 大屏 that
 * becomes the 主屏 continues from where the last one was.
 *
 * Returns the song to show on the idle page (null: none).
 */
export function useIdleMusic({ engine, main, audible, active, volume }: IdleMusicOptions): Song | null {
  const { data } = useQuery({ queryKey: ['idle-music'], queryFn: api.idleMusic, staleTime: 30_000, refetchInterval: 60_000 })
  const songs = data?.enabled ? data.songs : []
  const songsRef = useRef(songs)
  songsRef.current = songs
  const idleSync = useApp((s) => s.idleSync)
  const volRef = useRef(volume)
  volRef.current = volume
  const mainRef = useRef(main)
  mainRef.current = main

  // A pending fade-out (then pause). Volume changes leave a fade-out alone.
  const fadeTimer = useRef<number | undefined>(undefined)
  const fading = useRef(false)
  const cancelFade = () => {
    window.clearTimeout(fadeTimer.current)
    fading.current = false
  }
  const fadeOut = (tc: number, ms: number, then?: () => void) => {
    cancelFade()
    if (!engine.playing) return
    fading.current = true
    engine.setMaster(0, tc)
    fadeTimer.current = window.setTimeout(() => {
      fading.current = false
      engine.pause()
      then?.()
    }, ms)
  }

  /** 主屏: tell the server (and so the other 大屏) what the idle music is doing. */
  const report = useCallback(() => {
    if (!mainRef.current) return
    const id = idOf(engine.loadedKey)
    if (id === null) {
      sendMessage({ type: 'idleReport', songId: null, position: 0, playing: false })
      return
    }
    const out = engine.outputClock()
    const at = toServerTime(out.perf)
    sendMessage({ type: 'idleReport', songId: id, position: out.position, playing: engine.playing, ...(at !== null ? { at } : {}) })
  }, [engine])

  // ---------- 主屏: picks the song, plays it, reports ----------

  const [index, setIndex] = useState(0)
  const [shown, setShown] = useState<Song | null>(null)
  const failures = useRef(0)
  const resume = useRef<{ songId: number; position: number } | null>(null)

  // Becoming the 主屏 (or opening as it): continue where the last 主屏 left the idle music.
  const pickedUp = useRef(false)
  useEffect(() => {
    if (!main) {
      pickedUp.current = false
      return
    }
    if (pickedUp.current || !songs.length) return
    pickedUp.current = true
    const s = useApp.getState().idleSync
    const i = s ? songs.findIndex((x) => x.id === s.songId) : -1
    if (!s || i < 0) return
    setIndex(i)
    const pos = tvPosition(asPlayback(s), performance.now()) ?? s.position
    resume.current = { songId: s.songId, position: pos }
  }, [main, songs])

  const current = songs.length ? songs[index % songs.length]! : null
  const runMain = main && audible && active && !!current

  useEffect(() => {
    if (!main) return
    if (!runMain || !current) {
      // Fade out, then pause: the position is kept for next time.
      if (engine.playing && !fading.current) fadeOut(FADE_OUT_TC, FADE_OUT_MS, report)
      setShown(null)
      return
    }
    cancelFade()
    const song = current
    const key = keyOf(song.id)
    const start = (pos: number) => {
      engine.play(pos)
      engine.setMaster(volRef.current, FADE_IN_TC, 0)
      setShown(song)
      report()
    }
    if (engine.loadedKey === key) {
      // Already loaded: still sounding (a fade-out was interrupted, or this 大屏 was following
      // the old 主屏), or paused where it was.
      if (engine.playing) {
        engine.setMaster(volRef.current, FADE_IN_TC)
        setShown(song)
        report()
      } else start(resume.current?.songId === song.id ? resume.current.position : engine.position())
      resume.current = null
      return
    }
    const ac = new AbortController()
    const from = resume.current?.songId === song.id ? resume.current.position : 0
    api
      .prepareIdleSong(song.id)
      .then(() => (ac.signal.aborted ? false : engine.load(key, { main: mediaUrl(song.id, 'original') }, ac.signal)))
      .then((ok) => {
        if (!ok || ac.signal.aborted) return
        failures.current = 0
        resume.current = null
        start(from)
      })
      .catch(() => {
        if (ac.signal.aborted) return
        // Skip songs that can't be played; give up after a full round of failures.
        if (++failures.current < Math.max(1, songsRef.current.length)) window.setTimeout(() => setIndex((i) => i + 1), 1500)
      })
    return () => ac.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [main, runMain, current?.id, engine, report])

  // Next song when one ends (the list loops; a one-song list plays it again).
  useEffect(() => {
    engine.onEnded = () => {
      if (!mainRef.current) return
      const list = songsRef.current
      const id = idOf(engine.loadedKey)
      if (!list.length || id === null) return
      const i = list.findIndex((x) => x.id === id)
      const next = (i + 1) % list.length
      if (list[next]!.id === id) {
        engine.play(0)
        report()
      } else setIndex(next)
    }
    return () => {
      engine.onEnded = null
    }
  }, [engine, report])

  // Regular reports while it plays (the other 大屏 extrapolate in between).
  useEffect(() => {
    if (!runMain) return
    const t = window.setInterval(report, 1000)
    return () => window.clearInterval(t)
  }, [runMain, report])

  // ---------- other 大屏: show and (unmuted) play what the 主屏 plays ----------

  const followSong = !main && active && idleSync ? (songs.find((s) => s.id === idleSync.songId) ?? null) : null
  const follow = !main && audible && !!followSong
  const smooth = useRef<PlaybackSync | null>(null)
  useEffect(() => {
    smooth.current = idleSync ? smoothSync(smooth.current, asPlayback(idleSync)) : null
  }, [idleSync])

  const [loaded, setLoaded] = useState('')
  useEffect(() => {
    if (main) return
    if (!follow || !followSong) {
      if (engine.playing && !fading.current) fadeOut(0.1, 400)
      return
    }
    cancelFade()
    const key = keyOf(followSong.id)
    if (engine.loadedKey === key) {
      setLoaded(key)
      return
    }
    const ac = new AbortController()
    api
      .prepareIdleSong(followSong.id)
      .then(() => (ac.signal.aborted ? false : engine.load(key, { main: mediaUrl(followSong.id, 'original') }, ac.signal)))
      .then((ok) => {
        if (ok && !ac.signal.aborted) setLoaded(key)
      })
      .catch(() => {})
    return () => ac.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [main, follow, followSong?.id, engine])

  // Start on the 主屏's timeline and re-align when it drifts (same rules as song playback).
  useEffect(() => {
    if (main || !follow || !followSong) return
    const key = keyOf(followSong.id)
    if (loaded !== key) return
    let off = 0
    let joined = false
    const target = (perf: number) => tvPosition(smooth.current, perf) ?? NaN
    const tick = () => {
      const s = smooth.current
      if (!s || s.uid !== key || engine.loadedKey !== key) {
        if (engine.playing) engine.pause()
        return
      }
      if (!s.playing) {
        if (engine.playing) engine.pause()
        if (Math.abs(engine.position() - s.position) > 0.05) engine.seek(s.position)
        return
      }
      if (!engine.playing) {
        if (engine.playAligned(target) && !joined) {
          engine.setMaster(volRef.current, JOIN_TC)
          joined = true
        }
        off = 0
        return
      }
      if (!joined) {
        // Was already playing it (this 大屏 was the 主屏 a moment ago): keep going.
        engine.setMaster(volRef.current, JOIN_TC)
        joined = true
      }
      const out = engine.outputClock()
      const want = target(out.perf)
      if (!Number.isFinite(want)) return
      const drift = out.position - want
      off = Math.abs(drift) > 0.035 ? off + 1 : 0
      if (Math.abs(drift) > 0.2 || off >= 2) {
        engine.playAligned(target)
        off = 0
      }
    }
    tick()
    const t = window.setInterval(tick, 250)
    return () => window.clearInterval(t)
  }, [main, follow, followSong, loaded, engine])

  // ---------- both ----------

  // Volume changes (the 待机音乐 slider, this screen's own volume) apply right away.
  useEffect(() => {
    if (engine.playing && !fading.current) engine.setMaster(volume)
  }, [engine, volume])

  // Stop for good when the page goes away.
  useEffect(
    () => () => {
      window.clearTimeout(fadeTimer.current)
      engine.unload(0.05)
    },
    [engine],
  )

  if (!active) return null
  if (main) return shown && current && shown.id === current.id ? shown : null
  return followSong && idleSync?.playing ? followSong : null
}
