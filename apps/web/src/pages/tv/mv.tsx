import { useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AnimatePresence, motion } from 'motion/react'
import type { MvInfo, Song } from '@shared/types'
import { api, isRetryable, tokenized } from '../../lib/api'
import { type PlaybackClock } from '../../lib/playbackSync'
import { Icon } from '../../components/icons'
import { Cover, Spinner } from '../../components/ui'
import { Ambient } from './background'

/** 大屏 MV: fetching MV info, keeping a <video> in step with the song, the MV screen and backdrop. */

/** MV info for a song. While the server is still caching / aligning it, poll for a few minutes. */
export function useMv(song: Pick<Song, 'id' | 'mvId'>) {
  const pollUntil = useRef(Date.now() + 5 * 60_000)
  return useQuery({
    queryKey: ['mv', song.id],
    queryFn: () => api.mv(song.id),
    enabled: song.mvId > 0,
    retry: (count, e) => isRetryable(e) && count < 3,
    staleTime: 15_000,
    refetchInterval: (q) => {
      const d = q.state.data
      // Done: cached and aligned, or NetEase has no stream for it right now.
      const settled = d && ((d.cached && d.confidence !== null) || d.available === false)
      return settled || Date.now() > pollUntil.current ? false : 15_000
    },
  })
}

export type MvSync = { mode: 'synced'; offset: number } | { mode: 'free' }

/** Synced when the server aligned the MV confidently, or the durations match (same version). */
export function mvSyncFor(info: MvInfo | undefined, videoDuration: number, songDuration: number): MvSync {
  if (info && info.confidence !== null && info.confidence >= 0.5 && info.offset !== null) return { mode: 'synced', offset: info.offset }
  if (Number.isFinite(videoDuration) && songDuration > 0 && Math.abs(videoDuration - songDuration) <= 3) return { mode: 'synced', offset: 0 }
  return { mode: 'free' }
}

/** True when `t` lies inside an already-buffered range (with a little headroom). */
export function isBuffered(v: HTMLVideoElement, t: number) {
  for (let i = 0; i < v.buffered.length; i++) {
    if (t >= v.buffered.start(i) && t <= v.buffered.end(i) - 0.5) return true
  }
  return false
}

export const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x))

/**
 * Keeps a video element in step with the audio engine.
 * - free (not aligned, length differs from the song): played muted from the start together with
 *   the song — video time = audio time, wrapping round when the MV is shorter.
 * - synced: video time = audio time + offset. Small drift is absorbed by nudging the
 *   playback rate (0.9–1.1); large drift seeks, but only into buffered data (or a cached
 *   file) so a slow network doesn't turn into endless re-seeking. While the video is
 *   stalled nothing is forced; once it plays again it is re-aligned once.
 */
export function useMvSync(
  videoRef: MutableRefObject<HTMLVideoElement | null>,
  engine: PlaybackClock,
  sync: MvSync | null,
  cached: boolean,
  stalledRef: MutableRefObject<boolean>,
  realignRef: MutableRefObject<boolean>,
) {
  const mode = sync?.mode
  const offset = sync?.mode === 'synced' ? sync.offset : 0
  useEffect(() => {
    if (!sync) return
    let lastSeek = 0
    let heldAt: 'start' | 'end' | null = null
    const seek = (v: HTMLVideoElement, t: number) => {
      v.currentTime = t
      lastSeek = performance.now()
    }
    const tick = () => {
      const v = videoRef.current
      if (!v) return
      const playing = engine.playing && engine.hasTrack
      if (!Number.isFinite(v.duration) || v.duration <= 0) {
        if (v.playbackRate !== 1) v.playbackRate = 1
        if (playing && v.paused) v.play().catch(() => {})
        else if (!playing && !v.paused) v.pause()
        return
      }
      let target = engine.position() + offset
      if (mode === 'free') target = Math.max(0, target) % v.duration
      // Outside the MV (song intro before the MV starts, or past its end): hold a frame.
      else if (target < 0 || target > v.duration - 0.05) {
        const edge = target < 0 ? 'start' : 'end'
        if (!v.paused) v.pause()
        if (heldAt !== edge && !v.seeking) {
          seek(v, edge === 'start' ? 0 : Math.max(0, v.duration - 0.05))
          heldAt = edge
        }
        return
      }
      heldAt = null
      const drift = target - v.currentTime // > 0: video is behind the song
      const canSeek = !v.seeking && performance.now() - lastSeek > 2000 && (cached || isBuffered(v, target))
      if (!playing) {
        if (!v.paused) v.pause()
        if (v.playbackRate !== 1) v.playbackRate = 1
        if (Math.abs(drift) > 0.3 && canSeek) seek(v, target)
        return
      }
      if (v.paused) v.play().catch(() => {})
      if (stalledRef.current) {
        // Buffering: let it load instead of piling up seeks.
        if (v.playbackRate !== 1) v.playbackRate = 1
        return
      }
      if (realignRef.current) {
        realignRef.current = false
        if (Math.abs(drift) > 0.3 && !v.seeking && (cached || isBuffered(v, target))) {
          seek(v, target)
          return
        }
      }
      const a = Math.abs(drift)
      if (a <= 0.15) {
        if (v.playbackRate !== 1) v.playbackRate = 1
      } else if (a <= 1.5) {
        v.playbackRate = 1 + clamp(drift * 0.2, -0.1, 0.1)
      } else if (canSeek) {
        v.playbackRate = 1
        seek(v, target)
      } else {
        // Far behind and the target isn't buffered yet: run fast and let it catch up.
        v.playbackRate = drift > 0 ? 1.1 : 0.9
      }
    }
    tick()
    const t = window.setInterval(tick, 250)
    return () => window.clearInterval(t)
  }, [sync, mode, offset, cached, engine, videoRef, stalledRef, realignRef])
}

export function MvBackdrop({ song, engine, preload }: { song: Song; engine: PlaybackClock; preload: boolean }) {
  const { data } = useMv(song)
  const [failed, setFailed] = useState(false)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const stalledRef = useRef(false)
  const realignRef = useRef(false)
  useEffect(() => setFailed(false), [data?.url])
  // The backdrop is never aligned: it plays from the start together with the song (see useMvSync).
  const free = useMemo<MvSync>(() => ({ mode: 'free' }), [])
  const usable = !!data?.url && data.available !== false && !failed
  useMvSync(videoRef, engine, usable ? free : null, false, stalledRef, realignRef)
  if (!usable) return null
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 1.2 }}
      aria-hidden="true"
      className="absolute inset-0"
    >
      <video
        ref={videoRef}
        key={data!.url}
        src={tokenized(data!.url)}
        muted
        loop
        playsInline
        preload={preload ? 'auto' : 'metadata'}
        onError={() => setFailed(true)}
        className="h-full w-full object-cover opacity-50"
      />
      {/* Dark enough in the middle band for the stage lyrics to stay readable over bright frames. */}
      <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(7,7,11,0.75)_0%,rgba(7,7,11,0.55)_30%,rgba(7,7,11,0.6)_62%,rgba(7,7,11,0.92)_100%)]" />
    </motion.div>
  )
}

/**
 * Warms up the next song's MV while the current one plays (when 预载 MV is on): an
 * invisible muted <video preload="auto"> makes the browser fetch its start, so the real
 * element starts from a warm HTTP cache when the song comes up.
 */
export function NextMvPreloader({ song }: { song: Song }) {
  const { data } = useMv(song)
  if (!data?.url) return null
  return (
    <video
      aria-hidden="true"
      src={tokenized(data.url)}
      muted
      playsInline
      preload="auto"
      className="pointer-events-none absolute -z-10 h-px w-px opacity-0"
    />
  )
}

/**
 * MV mode: the video shown directly (contain, on black). It follows the audio clock when
 * the server aligned it (MvInfo.offset/confidence) or when it is the same version as the
 * audio (duration within ±3 s); otherwise it loops freely. No MV → blurred cover + ambient.
 */
export function MvScreen({
  song,
  engine,
  getSongDuration,
  preload,
  onModeKnown,
}: {
  song: Song
  engine: PlaybackClock
  getSongDuration: () => number
  preload: boolean
  /** Called once per song when it is known whether the MV is aligned to the audio. */
  onModeKnown?: (mode: MvSync['mode']) => void
}) {
  const { data, isLoading } = useMv(song)
  const [failed, setFailed] = useState(false)
  const [videoDuration, setVideoDuration] = useState(NaN)
  const [buffering, setBuffering] = useState(false)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const stalledRef = useRef(false)
  const realignRef = useRef(false)
  const url = data?.url
  useEffect(() => {
    setFailed(false)
    setVideoDuration(NaN)
  }, [url])
  const unavailable = data?.available === false || failed
  const hasVideo = !!url && !unavailable

  const offset = data?.offset ?? null
  const confidence = data?.confidence ?? null
  const sync = useMemo<MvSync | null>(() => {
    if (!hasVideo || !Number.isFinite(videoDuration)) return null
    return mvSyncFor(data, videoDuration, getSongDuration())
    // `data` identity changes on every poll; depend on the values that matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasVideo, videoDuration, offset, confidence, getSongDuration])

  useMvSync(videoRef, engine, sync, !!data?.cached, stalledRef, realignRef)

  // Tell the page whether this MV is aligned (once per song, and again if it becomes aligned later).
  const reported = useRef<MvSync['mode'] | null>(null)
  useEffect(() => {
    if (!sync || reported.current === sync.mode) return
    if (reported.current === null || sync.mode === 'synced') onModeKnown?.(sync.mode)
    reported.current = sync.mode
  }, [sync, onModeKnown])

  // "MV 缓冲中": only while the song is playing and the video has been waiting a moment.
  const [waiting, setWaiting] = useState(false)
  useEffect(() => {
    if (!waiting) {
      setBuffering(false)
      return
    }
    const t = window.setTimeout(() => setBuffering(engine.playing), 600)
    return () => window.clearTimeout(t)
  }, [waiting, engine])

  if (hasVideo)
    return (
      <div aria-hidden="true" className="absolute inset-0 bg-black">
        <video
          ref={videoRef}
          key={url}
          src={tokenized(url!)}
          muted
          playsInline
          preload={preload ? 'auto' : 'metadata'}
          loop={sync?.mode === 'free'}
          onLoadedMetadata={(e) => setVideoDuration(e.currentTarget.duration)}
          onWaiting={() => {
            stalledRef.current = true
            setWaiting(true)
          }}
          onPlaying={() => {
            if (stalledRef.current) realignRef.current = true
            stalledRef.current = false
            setWaiting(false)
          }}
          onCanPlayThrough={() => setWaiting(false)}
          onError={() => setFailed(true)}
          className="absolute inset-0 h-full w-full object-contain"
        />
        <div className="absolute inset-x-0 bottom-0 h-[46vh] bg-[linear-gradient(0deg,rgba(0,0,0,0.78)_0%,rgba(0,0,0,0.32)_55%,rgba(0,0,0,0)_100%)]" />
        <AnimatePresence>
          {buffering && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="glass absolute bottom-[3vh] left-[3.75vw] flex items-center gap-2 rounded-full px-3.5 py-1.5 text-[13px] whitespace-nowrap text-fg-2"
            >
              <Spinner size={13} /> MV 缓冲中
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    )

  return (
    <div aria-hidden="true" className="absolute inset-0 overflow-hidden bg-ink-2">
      <Cover song={song} px={600} className="absolute inset-0 h-full w-full scale-110 opacity-50 blur-[48px]" />
      <Ambient song={song} />
      {!isLoading && (
        <div className="absolute inset-x-0 top-[12vh] flex flex-col items-center gap-[2vh]">
          <Cover song={song} px={600} className="h-[34vh] w-[34vh] rounded-[32px] shadow-[0_40px_100px_rgba(0,0,0,0.6)]" />
          {unavailable && (
            <span className="glass flex items-center gap-2 rounded-full px-4 py-1.5 text-[clamp(13px,1vw,18px)] text-fg-2">
              <Icon name="video" size={16} /> 这首歌的 MV 暂时无法播放
            </span>
          )}
        </div>
      )}
      <div className="absolute inset-x-0 bottom-0 h-[46vh] bg-[linear-gradient(0deg,rgba(0,0,0,0.7)_0%,rgba(0,0,0,0)_100%)]" />
    </div>
  )
}
