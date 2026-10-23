import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import clsx from 'clsx'
import type { LyricLine, MvInfo, PlayerState, Song, TrackState } from '@shared/types'
import { toServerTime } from '../lib/clock'
import { useIdleMusic } from '../player/idleMusic'
import { api, imgUrl, isRetryable, mediaUrl, tokenized } from '../lib/api'
import { ambientColor, companionColor } from '../lib/color'
import { artistsText, deriveStatus, fmtTime } from '../lib/format'
import { useDebounced, useIsLocalhostOrigin, useRemoteUrl, useSettings } from '../lib/hooks'
import { currentLineIndex, hasLyrics, interludeCountdown, lineWords, wordFills } from '../lib/lyrics'
import { leadSegments, mergeSegments, seekLeadSegments, type LeadSegment } from '../lib/leadVocal'
import { AudioEngine } from '../player/engine'
import { useScoring } from '../player/useScoring'
import { DEFAULT_TOLERANCE } from '../player/scoring'
import type { MicError } from '../player/mic'
import { connect, livePosition, onCommand, sendCommand, sendMessage, useApp } from '../store/app'
import { Icon, type IconName } from '../components/icons'
import { Cover, ProgressBar, Range, Spinner, StatusPill } from '../components/ui'
import { QrCode } from '../components/QrCode'
import { PitchLane } from '../components/PitchLane'
import { LineRatingPop, ScoreOverlay, type ScoreResult } from '../components/ScoreOverlay'
import { DisplayModeToggle, TrackModeToggle, vocalModeCommand, type VocalMode } from '../components/PlayerModes'

const reduceMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

// ---------------- Ambient background ----------------

function Ambient({ song }: { song: Song | null }) {
  const [color, setColor] = useState('#FF4D7E')
  const picUrl = song?.album.picUrl
  useEffect(() => {
    let alive = true
    ambientColor(imgUrl(picUrl, 120)).then((c) => alive && setColor(c))
    return () => {
      alive = false
    }
  }, [picUrl])
  const second = companionColor(color)
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
      <AnimatePresence>
        <motion.div
          key={color}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 1.6 }}
          className="absolute inset-0"
        >
          <div
            className="ktv-drift absolute -top-[30vh] -left-[14vw] h-[100vh] w-[58vw] rounded-full opacity-[0.42] blur-[30px]"
            style={{ background: `radial-gradient(circle, ${color} 0%, rgba(0,0,0,0) 62%)` }}
          />
          <div
            className="ktv-drift-slow absolute top-[6vh] -right-[16vw] h-[92vh] w-[52vw] rounded-full opacity-[0.36] blur-[30px]"
            style={{ background: `radial-gradient(circle, ${second} 0%, rgba(0,0,0,0) 60%)` }}
          />
        </motion.div>
      </AnimatePresence>
      <div
        className="absolute -bottom-[52vh] left-[32vw] h-[84vh] w-[47vw] rounded-full opacity-[0.16] blur-[30px]"
        style={{ background: 'radial-gradient(circle, #FF9F43 0%, rgba(0,0,0,0) 60%)' }}
      />
    </div>
  )
}

/** A blob that wanders slowly to a new random spot every 9–16 s (idle page background). */
function WanderBlob({ className, style, range }: { className: string; style: React.CSSProperties; range: number }) {
  const pick = () => ({
    x: `${(Math.random() * 2 - 1) * range}vw`,
    y: `${(Math.random() * 2 - 1) * range * 0.8}vh`,
    scale: 0.85 + Math.random() * 0.35,
    duration: 9 + Math.random() * 7,
  })
  const [to, setTo] = useState(pick)
  return (
    <motion.div
      className={className}
      style={style}
      initial={{ x: 0, y: 0, scale: 1 }}
      animate={{ x: to.x, y: to.y, scale: to.scale }}
      transition={{ duration: to.duration, ease: 'easeInOut' }}
      onAnimationComplete={() => setTo(pick())}
    />
  )
}

/** Idle page background: the two glows drift around irregularly so the screen feels alive. */
function IdleAmbient() {
  return (
    <motion.div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 overflow-hidden"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 1.6 }}
    >
      <WanderBlob
        range={14}
        className="absolute -top-[30vh] -left-[14vw] h-[100vh] w-[58vw] rounded-full opacity-[0.42] blur-[30px]"
        style={{ background: 'radial-gradient(circle, #FF4D7E 0%, rgba(0,0,0,0) 62%)' }}
      />
      <WanderBlob
        range={12}
        className="absolute top-[6vh] -right-[16vw] h-[92vh] w-[52vw] rounded-full opacity-[0.36] blur-[30px]"
        style={{ background: `radial-gradient(circle, ${companionColor('#FF4D7E')} 0%, rgba(0,0,0,0) 60%)` }}
      />
      <div
        className="absolute -bottom-[52vh] left-[32vw] h-[84vh] w-[47vw] rounded-full opacity-[0.16] blur-[30px]"
        style={{ background: 'radial-gradient(circle, #FF9F43 0%, rgba(0,0,0,0) 60%)' }}
      />
    </motion.div>
  )
}

/** MV info for a song. While the server is still caching / aligning it, poll for a few minutes. */
function useMv(song: Pick<Song, 'id' | 'mvId'>) {
  const pollUntil = useRef(Date.now() + 5 * 60_000)
  return useQuery({
    queryKey: ['mv', song.id],
    queryFn: () => api.mv(song.id),
    enabled: song.mvId > 0,
    retry: (count, e) => isRetryable(e) && count < 3,
    staleTime: 15_000,
    refetchInterval: (q) => {
      const d = q.state.data
      const settled = d && d.cached && d.confidence !== null
      return settled || Date.now() > pollUntil.current ? false : 15_000
    },
  })
}

type MvSync = { mode: 'synced'; offset: number } | { mode: 'free' }

/** Synced when the server aligned the MV confidently, or the durations match (same version). */
function mvSyncFor(info: MvInfo | undefined, videoDuration: number, songDuration: number): MvSync {
  if (info && info.confidence !== null && info.confidence >= 0.5 && info.offset !== null) return { mode: 'synced', offset: info.offset }
  if (Number.isFinite(videoDuration) && songDuration > 0 && Math.abs(videoDuration - songDuration) <= 3) return { mode: 'synced', offset: 0 }
  return { mode: 'free' }
}

/** True when `t` lies inside an already-buffered range (with a little headroom). */
function isBuffered(v: HTMLVideoElement, t: number) {
  for (let i = 0; i < v.buffered.length; i++) {
    if (t >= v.buffered.start(i) && t <= v.buffered.end(i) - 0.5) return true
  }
  return false
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x))

/**
 * Keeps a video element in step with the audio engine.
 * - free: just mirrors play / pause (the MV loops on its own).
 * - synced: video time = audio time + offset. Small drift is absorbed by nudging the
 *   playback rate (0.9–1.1); large drift seeks, but only into buffered data (or a cached
 *   file) so a slow network doesn't turn into endless re-seeking. While the video is
 *   stalled nothing is forced; once it plays again it is re-aligned once.
 */
function useMvSync(
  videoRef: MutableRefObject<HTMLVideoElement | null>,
  engine: AudioEngine,
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
      if (mode === 'free' || !Number.isFinite(v.duration)) {
        if (v.playbackRate !== 1) v.playbackRate = 1
        if (playing && v.paused) v.play().catch(() => {})
        else if (!playing && !v.paused) v.pause()
        return
      }
      const target = engine.position() + offset
      // Outside the MV (song intro before the MV starts, or past its end): hold a frame.
      if (target < 0 || target > v.duration - 0.05) {
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

function MvBackdrop({ song, engine, preload }: { song: Song; engine: AudioEngine; preload: boolean }) {
  const { data } = useMv(song)
  const [failed, setFailed] = useState(false)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const stalledRef = useRef(false)
  const realignRef = useRef(false)
  useEffect(() => setFailed(false), [data?.url])
  // The backdrop loops on its own, but must pause / resume together with the song.
  const free = useMemo<MvSync>(() => ({ mode: 'free' }), [])
  useMvSync(videoRef, engine, data?.url && !failed ? free : null, false, stalledRef, realignRef)
  if (!data?.url || failed) return null
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
        key={data.url}
        src={tokenized(data.url)}
        muted
        loop
        playsInline
        preload={preload ? 'auto' : 'metadata'}
        onError={() => setFailed(true)}
        className="h-full w-full object-cover opacity-55"
      />
      <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(7,7,11,0.75)_0%,rgba(7,7,11,0.35)_35%,rgba(7,7,11,0.45)_60%,rgba(7,7,11,0.92)_100%)]" />
    </motion.div>
  )
}

/**
 * Warms up the next song's MV while the current one plays (when 预载 MV is on): an
 * invisible muted <video preload="auto"> makes the browser fetch its start, so the real
 * element starts from a warm HTTP cache when the song comes up.
 */
function NextMvPreloader({ song }: { song: Song }) {
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
function MvScreen({
  song,
  engine,
  getSongDuration,
  preload,
  onModeKnown,
}: {
  song: Song
  engine: AudioEngine
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
  const hasVideo = !!url && !failed

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
        <div className="absolute inset-x-0 top-[16vh] flex justify-center">
          <Cover song={song} px={600} className="h-[38vh] w-[38vh] rounded-[32px] shadow-[0_40px_100px_rgba(0,0,0,0.6)]" />
        </div>
      )}
      <div className="absolute inset-x-0 bottom-0 h-[46vh] bg-[linear-gradient(0deg,rgba(0,0,0,0.7)_0%,rgba(0,0,0,0)_100%)]" />
    </div>
  )
}

const Vignette = () => (
  <div
    aria-hidden="true"
    className="pointer-events-none absolute inset-0"
    style={{
      background:
        'radial-gradient(ellipse at 50% 46%, rgba(7,7,11,0) 0%, rgba(7,7,11,0.5) 68%, rgba(7,7,11,0.9) 100%)',
    }}
  />
)

// ---------------- Lyrics ----------------

function useClock(getMs: () => number, active: boolean) {
  const [ms, setMs] = useState(0)
  useEffect(() => {
    if (!active) return
    let raf = 0
    let last = -1
    const tick = () => {
      const v = getMs()
      if (Math.abs(v - last) >= 16) {
        last = v
        setMs(v)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [getMs, active])
  return ms
}

function useLyrics(songId: number) {
  return useQuery({ queryKey: ['lyrics', songId], queryFn: () => api.lyrics(songId), staleTime: Infinity })
}

/**
 * Countdown shown above the first line of a section (3–5 dots, see lib/lyrics.ts), the
 * rightmost one disappearing each second, the last one vanishing exactly as the line begins.
 * Absolutely positioned so it never shifts the lyrics.
 */
function CountdownDots({ dots, total, align = 'center' }: { dots: number; total: number; align?: 'center' | 'left' | 'right' }) {
  return (
    <div
      aria-hidden="true"
      className={clsx(
        'pointer-events-none absolute bottom-full mb-[0.4em] flex gap-[0.5em]',
        align === 'center' && 'left-1/2 -translate-x-1/2',
        align === 'left' && 'left-0',
        align === 'right' && 'right-0',
      )}
    >
      {Array.from({ length: total }, (_, i) => {
        // Dots disappear from right to left: the rightmost one goes first.
        const on = i < dots
        return (
          <span
            key={i}
            className="block h-[0.5em] w-[0.5em] rounded-full bg-accent transition-[opacity,transform] duration-300 motion-reduce:transition-none"
            style={{
              opacity: on ? 1 : 0,
              transform: on ? 'scale(1)' : 'scale(0.3)',
              boxShadow: on ? '0 0 0.4em rgba(255,77,126,0.85), 0 0 0 0.06em rgba(8,8,12,0.6)' : 'none',
            }}
          />
        )
      })}
    </div>
  )
}

function CurrentLine({ line, ms, showTranslation }: { line: LyricLine; ms: number; showTranslation: boolean }) {
  const words = lineWords(line)
  const fills = wordFills(line, ms)
  return (
    <div className="flex flex-col items-center gap-[2vh]">
      <p className="m-0 px-[4vw] text-[clamp(40px,4.8vw,104px)] leading-[1.15] font-black tracking-[0.04em]">
        {words.map((w, i) => {
          const p = fills[i] ?? 0
          return (
            <span
              key={i}
              style={{
                backgroundImage: `linear-gradient(90deg, #FFFFFF ${p}%, rgba(255,255,255,0.34) ${p}%)`,
                WebkitBackgroundClip: 'text',
                backgroundClip: 'text',
                color: 'transparent',
                filter: p >= 100 ? 'drop-shadow(0 0 22px rgba(255,77,126,0.75))' : 'none',
                whiteSpace: 'pre-wrap',
              }}
            >
              {w.text}
            </span>
          )
        })}
      </p>
      {showTranslation && (line.translation || line.roma) && (
        <p className="num m-0 px-[4vw] text-[clamp(18px,1.45vw,32px)] tracking-[0.02em] text-[#C8C8D0]">
          {line.translation || line.roma}
        </p>
      )}
    </div>
  )
}

function LyricsView({ songId, getMs, song }: { songId: number; getMs: () => number; song: Song }) {
  const { data } = useLyrics(songId)
  const ms = useClock(getMs, hasLyrics(data))
  if (!data) return null
  if (!hasLyrics(data))
    return (
      <div className="flex flex-col items-center gap-6 text-center">
        <Cover song={song} px={600} className="h-[30vh] w-[30vh] rounded-[28px] shadow-[0_30px_80px_rgba(0,0,0,0.5)]" />
        <div className="flex flex-col gap-2">
          <p className="m-0 text-[clamp(36px,3.6vw,72px)] font-black">{song.name}</p>
          <p className="m-0 text-[clamp(16px,1.3vw,26px)] text-muted">这首歌暂无歌词，尽情发挥吧</p>
        </div>
      </div>
    )
  const lines = data.lines
  const idx = currentLineIndex(lines, ms)
  const cur = Math.max(0, idx)
  const prev = idx > 0 ? lines[idx - 1] : null
  const next1 = lines[cur + 1]
  const next2 = lines[cur + 2]
  const showTranslation = lines.some((l) => l.translation || l.roma)
  const countdown = interludeCountdown(lines, ms)
  return (
    <div className="flex w-full flex-col items-center gap-[2.8vh] text-center">
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.p
          key={'p' + (idx - 1)}
          layout
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -30 }}
          transition={{ duration: 0.35 }}
          className="m-0 min-h-[1.2em] px-[4vw] text-[clamp(22px,2.1vw,44px)] font-medium text-white/40"
        >
          {prev?.text ?? ' '}
        </motion.p>
        <motion.div
          key={'c' + cur}
          layout
          initial={{ opacity: 0, y: 40, scale: 0.94 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -40, scale: 0.92 }}
          transition={{ duration: 0.4 }}
          className="relative my-[1.5vh] text-[clamp(40px,4.8vw,104px)]"
        >
          {/* Intro: the first line is the big line and the one about to start. */}
          {countdown?.index === cur && <CountdownDots dots={countdown.dots} total={countdown.total} />}
          <CurrentLine line={lines[cur]} ms={idx < 0 ? -1 : ms} showTranslation={showTranslation} />
        </motion.div>
        <motion.p
          key={'n' + (cur + 1)}
          layout
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -30 }}
          transition={{ duration: 0.35 }}
          className="relative m-0 min-h-[1.2em] px-[4vw] text-[clamp(24px,2.4vw,50px)] font-semibold text-white/62"
        >
          {/* Interlude: the next line is the one about to start. */}
          {countdown && countdown.index === cur + 1 && <CountdownDots dots={countdown.dots} total={countdown.total} />}
          {next1?.text ?? ' '}
        </motion.p>
        <motion.p
          key={'m' + (cur + 2)}
          layout
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.35 }}
          className="m-0 min-h-[1.2em] px-[4vw] text-[clamp(20px,1.9vw,40px)] font-medium text-white/38"
        >
          {next2?.text ?? ' '}
        </motion.p>
      </AnimatePresence>
    </div>
  )
}

/** One KTV-style line over video: white text, pink fill as it is sung, dark outline for legibility. */
function KtvLine({ line, ms }: { line: LyricLine; ms: number }) {
  const words = lineWords(line)
  const fills = wordFills(line, ms)
  return (
    <p
      className="m-0 max-w-[88vw] leading-[1.22] font-black tracking-[0.03em]"
      style={{ filter: 'drop-shadow(0 3px 12px rgba(0,0,0,0.85))' }}
    >
      {words.map((w, i) => {
        const p = fills[i] ?? 0
        // Two layers per word: a dark outline underneath and the colored fill on top. A stroke
        // drawn on the fill itself sits half inside the glyph and eats thin CJK strokes.
        return (
          <span key={i} className="relative inline-block" style={{ whiteSpace: 'pre' }}>
            <span
              aria-hidden="true"
              className="absolute inset-0"
              style={{ color: 'transparent', WebkitTextStroke: '0.12em rgba(8,8,12,0.9)' }}
            >
              {w.text}
            </span>
            <span
              className="relative"
              style={{
                backgroundImage: `linear-gradient(90deg, #FF6B9A ${p}%, #FFFFFF ${p}%)`,
                WebkitBackgroundClip: 'text',
                backgroundClip: 'text',
                color: 'transparent',
              }}
            >
              {w.text}
            </span>
          </span>
        )
      })}
    </p>
  )
}

/**
 * Classic two-row KTV lyrics: even lines on the upper row (left-aligned), odd lines on
 * the lower row (right-aligned). The row being sung fills word by word while the other
 * row shows the upcoming line; once a line is done its row is replaced by the next-next one.
 */
function TwoLineLyrics({ songId, getMs, raised }: { songId: number; getMs: () => number; raised: boolean }) {
  const { data } = useLyrics(songId)
  const ms = useClock(getMs, hasLyrics(data))
  if (!data || !hasLyrics(data)) return null
  const lines = data.lines
  const idx = currentLineIndex(lines, ms)
  let base = Math.max(0, idx)
  if (idx >= 0) {
    const l = lines[idx]
    if (ms > l.t + l.d + 400 && idx + 1 < lines.length) base = idx + 1 // finished: bring in the next pair early
  }
  const rows: (number | undefined)[] = [undefined, undefined]
  for (const i of [base, base + 1]) if (i < lines.length) rows[i % 2] = i
  const countdown = interludeCountdown(lines, ms)
  return (
    <div
      className={clsx(
        'pointer-events-none absolute inset-x-[5vw] flex flex-col gap-[1.4vh] text-[clamp(30px,3.5vw,76px)] transition-[bottom] duration-500 motion-reduce:transition-none',
        raised ? 'bottom-[30vh]' : 'bottom-[12vh]',
      )}
    >
      {rows.map((li, r) => (
        <div key={r} className={clsx('flex min-h-[1.25em]', r === 0 ? 'justify-start text-left' : 'justify-end text-right')}>
          <AnimatePresence mode="wait" initial={false}>
            {li !== undefined && (
              <motion.div
                key={li}
                initial={{ opacity: 0, y: 14 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                transition={{ duration: reduceMotion() ? 0 : 0.25 }}
                className="relative"
              >
                {countdown?.index === li && <CountdownDots dots={countdown.dots} total={countdown.total} align={r === 0 ? 'left' : 'right'} />}
                <KtvLine line={lines[li]} ms={ms} />
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      ))}
    </div>
  )
}

// ---------------- Header / footer pieces ----------------

function Chip({ children, icon }: { children: ReactNode; icon?: IconName }) {
  return (
    <span className="inline-flex h-[30px] items-center gap-1.5 rounded-full border border-white/10 bg-white/8 px-3 text-[15px] whitespace-nowrap text-[#E4E4EA]">
      {icon && <Icon name={icon} size={16} />}
      {children}
    </span>
  )
}

const fadeCls = (shown: boolean) =>
  clsx(
    'transition-[opacity,transform] duration-500 motion-reduce:transition-none',
    shown ? 'opacity-100' : 'pointer-events-none translate-y-2 opacity-0',
  )

function Header({ player, track, auxShown }: { player: PlayerState; track?: TrackState; auxShown: boolean }) {
  const cur = player.current!
  const queue = useApp((s) => s.state.queue)
  const tracks = useApp((s) => s.state.tracks)
  const { data: lyrics } = useLyrics(cur.song.id)
  const next = queue[0]
  const nextStatus = next ? deriveStatus(next.song, tracks[next.song.id], true) : null
  const working = queue.find((q) => {
    const st = tracks[q.song.id]?.status
    return st === 'separating' || st === 'downloading'
  })
  const workingTrack = working ? tracks[working.song.id] : undefined
  const karaoke = player.trackMode === 'karaoke' && track?.hasStems
  return (
    <header className="absolute top-[5.2vh] right-[3.75vw] left-[3.75vw] flex items-start justify-between gap-8">
      <div className="flex min-w-0 items-center gap-6">
        <Cover song={cur.song} px={300} className="h-24 w-24 rounded-[18px] shadow-[0_18px_40px_rgba(0,0,0,0.45)]" />
        <div className="flex min-w-0 flex-col gap-2">
          <h1 className="m-0 truncate text-[34px] font-bold tracking-[0.01em]">{cur.song.name}</h1>
          <div className="truncate text-xl text-[#B4B4BE]">
            {artistsText(cur.song)}
            {cur.song.album.name && ` · ${cur.song.album.name}`}
          </div>
          <div className="mt-1.5 flex flex-wrap gap-2.5">
            {karaoke ? (player.leadVocal ? <Chip icon="note">领唱</Chip> : <Chip icon="wave">伴唱</Chip>) : <Chip icon="mic">原唱</Chip>}
            {lyrics?.kind === 'yrc' && <Chip icon="lyrics">逐字歌词</Chip>}
            {track?.source === 'unblock' && <Chip icon="globe">第三方音源</Chip>}
            {player.key !== 0 && <Chip>{player.key > 0 ? `升 ${player.key} 调` : `降 ${-player.key} 调`}</Chip>}
          </div>
        </div>
      </div>
      <div className={clsx('flex shrink-0 flex-col items-end gap-4', fadeCls(auxShown))}>
        <QrCard />
        {next && nextStatus && (
          <div className="glass flex items-center gap-4 rounded-[20px] py-3.5 pr-5 pl-3.5">
            <Cover song={next.song} px={120} className="h-14 w-14 rounded-xl" />
            <div className="flex max-w-[22vw] min-w-0 flex-col gap-1">
              <div className="text-sm tracking-[0.12em] text-muted">下一首</div>
              <div className="truncate text-xl font-semibold">
                {next.song.name} <span className="font-normal text-[#B4B4BE]">· {artistsText(next.song)}</span>
              </div>
            </div>
            <span className="ml-2">
              <StatusPill status={nextStatus} large />
            </span>
          </div>
        )}
        <div className="flex items-center gap-3 text-base text-[#B4B4BE]">
          {working && workingTrack && (
            <>
              <Icon name="sparkles" size={18} className="text-accent" />
              <span className="max-w-[18vw] truncate">
                {workingTrack.status === 'downloading' ? '下载中' : 'AI 伴奏分离'} · {working.song.name}
              </span>
              <ProgressBar value={workingTrack.progress} color="#FF4D7E" className="w-[120px]" />
              <span className="num text-[#E4E4EA]">{Math.round(workingTrack.progress * 100)}%</span>
              <span className="text-faint">|</span>
            </>
          )}
          <span>已点 {queue.length + 1} 首</span>
        </div>
      </div>
    </header>
  )
}

/** MV mode: song title in the corner, shown briefly when a song starts (and while the UI is awake). */
function MvTitle({ song, shown }: { song: Song; shown: boolean }) {
  return (
    <div className={clsx('absolute top-[5.2vh] left-[3.75vw] flex max-w-[60vw] items-center gap-4', fadeCls(shown))}>
      <Cover song={song} px={160} className="h-16 w-16 rounded-2xl shadow-[0_12px_30px_rgba(0,0,0,0.5)]" />
      <div className="flex min-w-0 flex-col gap-1" style={{ filter: 'drop-shadow(0 2px 10px rgba(0,0,0,0.85))' }}>
        <span className="truncate text-[30px] leading-tight font-bold">{song.name}</span>
        <span className="truncate text-lg text-fg-2">{artistsText(song)}</span>
      </div>
    </div>
  )
}

function Progress({ getPos, duration }: { getPos: () => number; duration: number }) {
  const [pos, setPos] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setPos(getPos()), 250)
    return () => clearInterval(t)
  }, [getPos])
  const pct = duration ? Math.min(100, (pos / duration) * 100) : 0
  return (
    <div className="num flex items-center gap-5 text-lg text-[#C8C8D0]">
      <span>{fmtTime(pos)}</span>
      <div
        role="slider"
        tabIndex={-1}
        aria-label="播放进度"
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={Math.round(pos)}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          sendCommand({ action: 'seek', position: ((e.clientX - r.left) / r.width) * duration })
        }}
        className="relative h-1.5 flex-1 cursor-pointer rounded-full bg-white/14"
      >
        <div
          className="absolute inset-y-0 left-0 rounded-full"
          style={{ width: pct + '%', background: 'linear-gradient(90deg, #FF4D7E 0%, #FFB3C6 100%)', boxShadow: '0 0 16px #FF4D7E' }}
        />
      </div>
      <span>{fmtTime(duration)}</span>
    </div>
  )
}

type SetPatch = Omit<Extract<Parameters<typeof sendCommand>[0], { action: 'set' }>, 'action'>
const setPlayer = (patch: SetPatch) => sendCommand({ action: 'set', ...patch })

function ControlPill({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={clsx('glass flex h-14 shrink-0 items-center gap-2.5 rounded-[18px] px-4 whitespace-nowrap', className)}>
      {children}
    </div>
  )
}

function BarButton({
  icon,
  label,
  title,
  onClick,
  primary,
  text,
}: {
  icon: IconName
  label: string
  title?: string
  onClick: () => void
  primary?: boolean
  /** Visible label, shown from xl up. */
  text?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={title ?? label}
      className={clsx(
        'flex shrink-0 items-center justify-center gap-2 whitespace-nowrap transition-[transform,background-color]',
        primary
          ? 'h-14 w-14 rounded-full bg-accent text-accent-ink shadow-[0_10px_28px_rgba(255,77,126,0.45)] hover:scale-105'
          : clsx('glass h-14 rounded-[18px] hover:bg-white/10', text ? 'min-w-14 px-4 text-[15px]' : 'w-14'),
      )}
    >
      <Icon name={icon} size={primary ? 24 : 20} />
      {text && <span className="hidden xl:inline">{text}</span>}
    </button>
  )
}

/** Volume summary pill; the sliders live in a popover so the bar never grows. */
function MixerButton({
  player,
  karaoke,
  open,
  onToggle,
}: {
  player: PlayerState
  karaoke: boolean
  open: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-haspopup="dialog"
      title="音量"
      className={clsx(
        'glass flex h-14 shrink-0 items-center gap-2.5 rounded-[18px] px-4 text-[15px] whitespace-nowrap transition-colors hover:bg-white/10',
        open && 'bg-white/12',
      )}
    >
      <Icon name="volume" size={20} />
      <span className="hidden xl:inline">{karaoke ? '伴奏' : '音量'}</span>
      <span className="num text-[#E4E4EA]">{Math.round(player.musicVolume * 100)}%</span>
    </button>
  )
}

function MixerPopover({ player, karaoke }: { player: PlayerState; karaoke: boolean }) {
  const row = (icon: IconName, label: string, value: number, onChange: (v: number) => void) => (
    <div className="flex items-center gap-3">
      <Icon name={icon} size={18} className="shrink-0 text-fg-2" />
      <span className="w-12 shrink-0 text-[15px] whitespace-nowrap">{label}</span>
      <div className="min-w-0 flex-1">
        <Range label={label + '音量'} value={Math.round(value * 100)} onChange={(v) => onChange(v / 100)} color="#FFFFFF" />
      </div>
      <span className="num w-11 shrink-0 text-right text-[15px] text-[#C8C8D0]">{Math.round(value * 100)}%</span>
    </div>
  )
  return (
    <div
      role="dialog"
      aria-label="音量"
      className="glass flex w-[340px] flex-col gap-4 rounded-[20px] p-5 shadow-[0_24px_60px_rgba(0,0,0,0.55)]"
    >
      {row('volume', karaoke ? '伴奏' : '音量', player.musicVolume, (v) => setPlayer({ musicVolume: v }))}
    </div>
  )
}

function KeyControl({ value, pending }: { value: number; pending?: boolean }) {
  return (
    <ControlPill className="pr-2 pl-4">
      <span className="hidden text-[15px] min-[1440px]:inline">{pending ? '变调中' : '升降调'}</span>
      <button
        type="button"
        aria-label="降调"
        disabled={value <= -6}
        onClick={() => setPlayer({ key: value - 1 })}
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white/8 hover:bg-white/14 disabled:opacity-40"
      >
        <Icon name="minus" size={18} strokeWidth={2} />
      </button>
      <span
        className="num relative flex w-9 items-center justify-center text-[20px] font-semibold text-accent"
        aria-live="polite"
        title={pending ? '正在处理变调，几秒后生效' : '当前调'}
      >
        <span className={clsx(pending && 'opacity-40')}>{value > 0 ? '+' + value : value}</span>
        {pending && (
          <span className="absolute inset-0 flex items-center justify-center text-fg">
            <Spinner size={18} />
          </span>
        )}
      </span>
      <button
        type="button"
        aria-label="升调"
        disabled={value >= 6}
        onClick={() => setPlayer({ key: value + 1 })}
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white/8 hover:bg-white/14 disabled:opacity-40"
      >
        <Icon name="plus" size={18} strokeWidth={2} />
      </button>
    </ControlPill>
  )
}

/**
 * One-row TV control bar: transport · modes · (spacer) · mixer / key / scoring.
 * Never wraps: labels collapse to icons below 1280 px, and below 1024 px the row scrolls
 * sideways. Popovers render outside the scrolling row so they are never clipped.
 */
function Controls({
  player,
  hasStems,
  extra,
  keyPending,
}: {
  player: PlayerState
  hasStems: boolean
  extra?: ReactNode
  keyPending?: boolean
}) {
  const karaoke = hasStems && player.trackMode === 'karaoke'
  const [mixerOpen, setMixerOpen] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!mixerOpen) return
    const onDown = (e: PointerEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setMixerOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMixerOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [mixerOpen])

  return (
    <div ref={boxRef} className="relative min-w-0">
      {mixerOpen && (
        <div className="absolute right-0 bottom-full z-20 mb-3">
          <MixerPopover player={player} karaoke={karaoke} />
        </div>
      )}
      <div className="flex min-w-0 flex-nowrap items-center gap-3 max-lg:overflow-x-auto max-lg:pb-1">
        <BarButton
          primary
          icon={player.playing ? 'pause' : 'play'}
          label={player.playing ? '暂停' : '播放'}
          title={player.playing ? '暂停（空格）' : '播放（空格）'}
          onClick={() => sendCommand({ action: 'toggle' })}
        />
        <BarButton icon="replay" label="重唱" onClick={() => sendCommand({ action: 'restart' })} />
        <BarButton icon="next" label="切歌" title="切歌（N）" text="切歌" onClick={() => sendCommand({ action: 'next' })} />
        <span className="mx-1 h-8 w-px shrink-0 bg-white/12" aria-hidden="true" />
        <TrackModeToggle size="tv" />
        <DisplayModeToggle size="tv" />
        <span className="min-w-2 flex-1" aria-hidden="true" />
        <MixerButton player={player} karaoke={karaoke} open={mixerOpen} onToggle={() => setMixerOpen((v) => !v)} />
        <KeyControl value={player.key} pending={keyPending} />
        {extra}
      </div>
    </div>
  )
}

const SCORE_PREF = 'ktv.scoring'

function readScorePref() {
  try {
    return localStorage.getItem(SCORE_PREF) === '1'
  } catch {
    return false
  }
}

function ScoreToggle({
  on,
  onToggle,
  hasPitch,
  status,
  micError,
  pitchError,
}: {
  on: boolean
  onToggle: () => void
  hasPitch: boolean
  status: 'off' | 'loading' | 'on' | 'error'
  micError: MicError | null
  pitchError: boolean
}) {
  let hint: string | null = null
  if (on) {
    if (!window.isSecureContext || micError === 'insecure') hint = '麦克风需要通过 localhost 或 HTTPS 打开主屏'
    else if (micError === 'denied') hint = '麦克风权限被拒绝，请在浏览器里允许'
    else if (micError === 'unavailable') hint = '没有找到可用的麦克风'
    else if (!hasPitch) hint = '这首歌暂无参考音高（需要伴奏分离）'
    else if (pitchError) hint = '参考音高加载失败'
    else if (status === 'loading') hint = '正在打开麦克风…'
  }
  return (
    <div className="relative shrink-0">
      {hint && (
        <div className="glass absolute right-0 bottom-full mb-3 w-max max-w-[300px] rounded-xl px-3.5 py-2 text-[13px] leading-5 text-warn shadow-[0_12px_30px_rgba(0,0,0,0.45)]">
          {hint}
        </div>
      )}
      <button
        type="button"
        aria-pressed={on}
        onClick={onToggle}
        title={hint ?? (on ? '关闭评分' : '打开评分')}
        className={clsx(
          'flex h-14 shrink-0 items-center gap-2 rounded-[18px] px-4 text-[15px] whitespace-nowrap transition-colors',
          on ? 'bg-accent font-semibold text-accent-ink' : 'glass text-fg hover:bg-white/10',
        )}
      >
        <Icon name="mic" size={20} />
        评分
        {hint && <span className="h-2 w-2 rounded-full bg-warn" aria-hidden="true" />}
      </button>
    </div>
  )
}

function QrCard({ big }: { big?: boolean }) {
  const url = useRemoteUrl()
  const localhost = useIsLocalhostOrigin()
  const display = url.replace(/^https?:\/\//, '').replace(/\?.*$/, '')
  return (
    <div className={clsx('glass flex items-center rounded-3xl', big ? 'gap-8 p-6 pr-10' : 'gap-5.5 p-4.5 pr-6.5')}>
      <QrCode value={url} size={big ? 220 : 132} label="扫码点歌二维码" />
      <div className="flex flex-col gap-1.5">
        <div className={clsx('font-bold whitespace-nowrap', big ? 'text-[34px]' : 'text-2xl')}>扫码点歌</div>
        <div className={clsx('whitespace-nowrap text-[#B4B4BE]', big ? 'text-lg' : 'text-base')}>同一 Wi‑Fi 下用手机扫描</div>
        <div className={clsx('num mt-1.5 font-medium whitespace-nowrap text-accent', big ? 'text-xl' : 'text-[17px]')}>{display}</div>
        {localhost && (
          <div className="mt-1 max-w-[260px] text-[13px] leading-5 text-warn">
            当前通过 localhost 打开，手机无法访问。请在点歌台“设置”里填写局域网地址。
          </div>
        )}
      </div>
    </div>
  )
}

// ---------------- Idle auto-hide + OSD ----------------

/**
 * True after `timeout` ms without pointer / key / touch activity. Never goes idle while
 * the pointer is over the held area or one of its controls has keyboard focus.
 */
function useIdle(enabled: boolean, timeout = 4000) {
  const [idle, setIdle] = useState(false)
  const holdRef = useRef<HTMLDivElement | null>(null)
  const hoverRef = useRef(false)
  useEffect(() => {
    if (!enabled) {
      setIdle(false)
      return
    }
    let t = 0
    const check = () => {
      const el = holdRef.current
      const active = document.activeElement as HTMLElement | null
      const focused = !!el && !!active && el.contains(active) && active.matches(':focus-visible')
      if (hoverRef.current || focused) arm()
      else setIdle(true)
    }
    const arm = () => {
      window.clearTimeout(t)
      t = window.setTimeout(check, timeout)
    }
    const wake = () => {
      setIdle(false)
      arm()
    }
    const events = ['pointermove', 'pointerdown', 'keydown', 'touchstart', 'wheel'] as const
    events.forEach((e) => window.addEventListener(e, wake, { passive: true }))
    arm()
    return () => {
      window.clearTimeout(t)
      events.forEach((e) => window.removeEventListener(e, wake))
    }
  }, [enabled, timeout])
  return { idle, holdRef, hoverRef }
}

interface OsdMsg {
  id: number
  text: string
  icon?: IconName
}

function Osd({ msg }: { msg: OsdMsg | null }) {
  return (
    <div className="pointer-events-none absolute top-[9vh] left-1/2 z-30 -translate-x-1/2" aria-live="polite">
      <AnimatePresence>
        {msg && (
          <motion.div
            key={msg.id}
            initial={{ opacity: 0, y: -10, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: reduceMotion() ? 0 : 0.2 }}
            className="glass flex items-center gap-2.5 rounded-full px-6 py-3 text-[clamp(18px,1.3vw,26px)] font-semibold whitespace-nowrap shadow-[0_16px_40px_rgba(0,0,0,0.45)]"
          >
            {msg.icon && <Icon name={msg.icon} size={22} className="text-accent" />}
            {msg.text}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

const pctText = (v: number) => Math.round(v * 100) + '%'

/** Turn player-state changes (usually from the phone) into short on-screen messages. */
function useOsd(player: PlayerState) {
  const [msg, setMsg] = useState<OsdMsg | null>(null)
  const storeReady = useApp((s) => s.ready)
  const prevRef = useRef<PlayerState | null>(null)
  const show = useCallback((text: string, icon?: IconName) => setMsg({ id: Date.now() + Math.random(), text, icon }), [])
  useEffect(() => {
    if (!msg) return
    const t = window.setTimeout(() => setMsg(null), 1400)
    return () => window.clearTimeout(t)
  }, [msg])
  useEffect(() => {
    if (!storeReady) {
      prevRef.current = null
      return
    }
    const prev = prevRef.current
    prevRef.current = player
    if (!prev) return
    const sameSong = prev.current?.uid === player.current?.uid
    if (!sameSong) {
      if (prev.current && player.current) show(`切歌 · 《${player.current.song.name}》`, 'next')
      return
    }
    // 伴唱 / 领唱 / 原唱 changes need no banner: the control bar and header chip already show it.
    if (prev.displayMode !== player.displayMode) show(player.displayMode === 'mv' ? 'MV 模式' : '舞台模式', player.displayMode === 'mv' ? 'video' : 'lyrics')
    else if (prev.key !== player.key) show(player.key === 0 ? '原调' : player.key > 0 ? `升调 +${player.key}` : `降调 ${player.key}`)
    else if (prev.musicVolume !== player.musicVolume) show(`音量 ${pctText(player.musicVolume)}`, 'volume')
  }, [player, storeReady, show])
  return { msg, show }
}

// ---------------- States ----------------

function IdleScreen() {
  const connected = useApp((s) => s.connected)
  return (
    <motion.div
      className="absolute inset-0 flex flex-col items-center justify-center gap-[6vh] px-[4vw] text-center"
      initial={{ opacity: 0, scale: 0.985 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 1.2, ease: 'easeOut' }}
    >
      <div className="flex flex-col items-center gap-5">
        <div className="flex h-20 w-20 items-center justify-center rounded-[24px] bg-[linear-gradient(135deg,#FF4D7E_0%,#8B5CF6_100%)] text-white shadow-[0_20px_60px_rgba(255,77,126,0.45)]">
          <Icon name="mic" size={40} strokeWidth={2} />
        </div>
        <h1 className="m-0 text-[clamp(40px,4.4vw,88px)] font-black tracking-[0.02em]">今晚，谁先开嗓？</h1>
        <p className="m-0 text-[clamp(16px,1.4vw,26px)] text-[#B4B4BE]">
          {connected ? '手机扫码，即刻开唱' : '正在连接 KTV 主机…'}
        </p>
      </div>
      <QrCard big />
    </motion.div>
  )
}

function PreparingScreen({ song, track, loading, loadError }: { song: Song; track?: TrackState; loading: boolean; loadError: string }) {
  let title = '正在准备'
  let detail = ''
  let progress: number | null = null
  let tone: 'normal' | 'warn' = 'normal'
  switch (track?.status) {
    case 'downloading':
      title = '正在下载歌曲'
      progress = track.progress
      break
    case 'queued':
      title = '排队等待生成伴奏'
      detail = '前面还有歌曲在处理'
      break
    case 'separating':
      title = '正在生成伴奏'
      progress = track.progress
      detail = 'AI 正在去除主唱、保留和声'
      break
    case 'unavailable':
      title = '这首歌无法播放'
      detail = track.message || (song.playable === 'vip' ? '需要会员才能播放完整版' : '网易云暂无音源')
      tone = 'warn'
      break
    case 'error':
      title = '伴奏生成失败'
      detail = (track.message ? track.message + ' · ' : '') + '可在点歌台重试或切到下一首'
      tone = 'warn'
      break
    case 'ready':
      title = loadError ? '音频加载失败' : '正在加载音频'
      detail = loadError
      tone = loadError ? 'warn' : 'normal'
      break
  }
  return (
    <div className="absolute inset-0 flex items-center justify-center px-[4vw]">
      <div className="flex flex-col items-center gap-8 text-center">
        <div className="relative">
          <Cover song={song} px={600} className="h-[34vh] w-[34vh] rounded-[32px] shadow-[0_30px_80px_rgba(0,0,0,0.55)]" />
          {(loading || progress !== null || track?.status === 'queued') && tone === 'normal' && (
            <div className="absolute -right-4 -bottom-4 flex h-16 w-16 items-center justify-center rounded-full bg-accent text-accent-ink shadow-[0_10px_30px_rgba(255,77,126,0.5)]">
              <Spinner size={28} />
            </div>
          )}
        </div>
        <div className="flex flex-col items-center gap-3">
          <div className="text-[clamp(28px,2.6vw,52px)] font-black">
            {title}
            {progress !== null && <span className="num ml-3 text-accent">{Math.round(progress * 100)}%</span>}
          </div>
          <div className="text-[clamp(18px,1.4vw,28px)] text-fg-2">
            {song.name} · {artistsText(song)}
          </div>
          {detail && <div className={clsx('text-base', tone === 'warn' ? 'text-warn' : 'text-muted')}>{detail}</div>}
          {progress !== null && <ProgressBar value={progress} color="#FF4D7E" className="mt-3 h-1.5 w-[32vw] max-w-[520px]" />}
        </div>
      </div>
    </div>
  )
}

/** True when `on` has stayed true for `ms` (hides flicker on fast loads). */
function useDelayedFlag(on: boolean, ms: number) {
  const [v, setV] = useState(false)
  useEffect(() => {
    if (!on) {
      setV(false)
      return
    }
    const t = window.setTimeout(() => setV(true), ms)
    return () => window.clearTimeout(t)
  }, [on, ms])
  return v
}

// ---------------- Page ----------------

export default function Tv() {
  const engineRef = useRef<AudioEngine | null>(null)
  if (!engineRef.current) engineRef.current = new AudioEngine()
  const engine = engineRef.current
  const [unlocked, setUnlocked] = useState(false)
  const [loadState, setLoadState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  // 领唱 segments: the section starts, plus the lines right after a seek (merged into the engine).
  const sectionLead = useRef<LeadSegment[]>([])
  const seekLead = useRef<LeadSegment[]>([])
  const leadCtx = useRef<{ on: boolean; lines: LyricLine[] | null }>({ on: false, lines: null })
  const applyLead = useCallback(() => {
    const e = engineRef.current!
    e.setLeadSegments(leadCtx.current.on ? mergeSegments([...sectionLead.current, ...seekLead.current]) : [])
  }, [])
  /** Before jumping to `pos`: let the original vocal carry the singer back in. */
  const leadAfterSeek = useCallback(
    (pos: number) => {
      const { on, lines } = leadCtx.current
      const e = engineRef.current!
      seekLead.current = on && lines && e.hasTrack ? seekLeadSegments(lines, e.vocalActivity(), pos) : []
      applyLead()
    },
    [applyLead],
  )
  const [loadError, setLoadError] = useState('')
  const player = useApp((s) => s.state.player)
  const tracks = useApp((s) => s.state.tracks)
  const queue = useApp((s) => s.state.queue)
  const connected = useApp((s) => s.connected)
  const tvActive = useApp((s) => s.tvActive)
  // Only the one active TV plays audio; any other open TV page stays silent.
  const audible = unlocked && tvActive === true
  const { data: settings } = useSettings()
  const [scoreOn, setScoreOn] = useState(readScorePref)
  const [scoreResult, setScoreResult] = useState<ScoreResult | null>(null)
  const finishRef = useRef<() => ScoreResult | null>(() => null)
  const toggleScore = useCallback(() => {
    setScoreOn((v) => {
      try {
        localStorage.setItem(SCORE_PREF, v ? '0' : '1')
      } catch {
        /* storage unavailable */
      }
      return !v
    })
  }, [])
  const clearScoreResult = useCallback(() => setScoreResult(null), [])

  useEffect(() => connect('tv'), [])
  useEffect(() => {
    document.title = '主屏 · Netease KTV'
  }, [])

  const report = useCallback(() => {
    if (!engine.hasTrack || useApp.getState().tvActive !== true) return
    // Stamp the report with when this sample comes out of the speakers (server clock), so 耳返
    // phones can play in step. uid / epoch say which song the audio belongs to.
    const out = engine.outputClock()
    const at = toServerTime(out.perf)
    const [uid, epoch] = engine.loadedKey.split('|')
    sendMessage({
      type: 'report',
      position: out.position,
      playing: engine.playing,
      ...(at !== null ? { at } : {}),
      ...(uid ? { uid, epoch: Number(epoch) } : {}),
    })
  }, [engine])

  // Keep audio on this TV across a brief reconnect: if it was the active TV, claim it back.
  const wasActive = useRef(false)
  const connectedAt = useRef(0)
  useEffect(() => {
    if (!connected) return
    connectedAt.current = Date.now()
    if (unlocked && wasActive.current) sendMessage({ type: 'claim' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected])
  useEffect(() => {
    if (tvActive === true) wasActive.current = true
    // Another TV took over (not just the role reset right after our reconnect).
    else if (tvActive === false && Date.now() - connectedAt.current > 3000) wasActive.current = false
  }, [tvActive])

  const cur = player.current
  const track = cur ? tracks[cur.song.id] : undefined
  const ready = track?.status === 'ready'
  const hasStems = !!track?.hasStems
  const mvMode = (player.displayMode ?? 'stage') === 'mv'
  const songKey = cur ? `${cur.uid}|${player.epoch}|` : ''
  // Key presses settle for a moment first, so tapping +3 renders one pitch, not three.
  const pitchKey = useDebounced(player.key, 500)
  // trackMode is deliberately NOT part of the key: with stems, 伴唱 ⇄ 原唱 is a gain change.
  const loadKey = cur && ready ? `${songKey}${pitchKey}|${hasStems ? 's' : 'o'}` : ''

  // load audio when the song / epoch / key / stems availability changes
  useEffect(() => {
    if (!audible) {
      // Not (or no longer) the active TV: make sure this page is silent.
      if (engine.hasTrack) engine.unload(0.15)
      setLoadState('idle')
      return
    }
    if (!loadKey || !cur) {
      if (engine.hasTrack) engine.unload(0.15)
      setLoadState('idle')
      return
    }
    if (engine.loadedKey === loadKey) return
    const sameSong = engine.loadedKey.startsWith(songKey)
    // a different song: fade the old one out right away instead of waiting for the download
    if (!sameSong && engine.hasTrack) engine.unload(0.15)
    const id = cur.song.id
    const k = pitchKey
    const ac = new AbortController()
    setLoadState('loading')
    setLoadError('')
    engine
      .load(
        loadKey,
        hasStems ? { main: mediaUrl(id, 'instrumental', k), vocals: mediaUrl(id, 'vocals', k) } : { main: mediaUrl(id, 'original', k) },
        ac.signal,
      )
      .then((ok) => {
        if (!ok) return
        setLoadState('ready')
        // Same song (key change): continue where the old buffers were. A song that has really
        // been played already (the server holds a reported position — page reload, another TV
        // taking over, server restart) resumes there and keeps its play/pause state. Anything
        // else is a fresh song: it starts from 0 now that its accompaniment is ready.
        const p = useApp.getState().state.player
        const fromServer = p.current?.uid === cur.uid && p.epoch === player.epoch && p.position > 0.5
        const resumeAt = sameSong ? engine.lastPosition : fromServer ? livePosition(p) : 0
        const resume = sameSong ? engine.lastPlaying : fromServer ? p.playing : true
        if (!sameSong) seekLead.current = []
        if (fromServer && resumeAt > 1) leadAfterSeek(resumeAt)
        if (resume) engine.play(resumeAt)
        else engine.seek(resumeAt)
        report()
      })
      .catch((e: unknown) => {
        if (ac.signal.aborted) return
        setLoadState('error')
        setLoadError(e instanceof Error ? e.message : '音频加载失败')
      })
    return () => ac.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadKey, audible])

  // gains: 伴唱 = no lead vocal at all; 原唱 = lead vocal at the backing-track level;
  // 领唱 = silent lead vocal except inside its segments, where it plays at that same level.
  const leadOn = !!player.leadVocal && hasStems && player.trackMode === 'karaoke'
  useEffect(() => {
    const music = player.musicVolume
    const vocal = hasStems && player.trackMode === 'original' ? music : 0
    engine.setVolumes(music, vocal, leadOn ? music : vocal)
  }, [engine, player.musicVolume, player.trackMode, hasStems, leadOn, loadState])
  if (import.meta.env.DEV) (window as unknown as { __ktvEngine: AudioEngine }).__ktvEngine = engine

  // prefetch the next ready song so 切歌 starts without a download
  const nextItem = queue[0]
  const nextTrack = nextItem ? tracks[nextItem.song.id] : undefined
  useEffect(() => {
    if (!audible || loadState !== 'ready' || !nextItem || nextTrack?.status !== 'ready') return
    const id = nextItem.song.id
    const urls = nextTrack.hasStems ? [mediaUrl(id, 'instrumental'), mediaUrl(id, 'vocals')] : [mediaUrl(id, 'original')]
    const t = window.setTimeout(() => engine.prefetch(urls), 1500)
    return () => window.clearTimeout(t)
  }, [engine, audible, loadState, nextItem, nextTrack?.status, nextTrack?.hasStems])

  const { msg: osd, show: showOsd } = useOsd(player)
  // 待机音乐 while nothing is queued (active TV only)
  useIdleMusic(audible && !cur, player.musicVolume)

  // server-forwarded commands
  useEffect(
    () =>
      onCommand((c) => {
        if (!engine.hasTrack) return
        switch (c.action) {
          case 'play':
            if (!engine.playing) engine.play()
            showOsd('播放', 'play')
            break
          case 'pause':
            engine.pause()
            showOsd('暂停', 'pause')
            break
          case 'toggle':
            if (engine.playing) engine.pause()
            else engine.play()
            showOsd(engine.playing ? '播放' : '暂停', engine.playing ? 'play' : 'pause')
            break
          case 'seek':
            leadAfterSeek(c.position)
            engine.seek(c.position)
            showOsd(fmtTime(c.position))
            break
          case 'restart':
            seekLead.current = []
            applyLead()
            engine.seek(0)
            if (!engine.playing) engine.play(0)
            showOsd('重唱', 'replay')
            break
          default:
            return
        }
        report()
      }),
    [engine, report, showOsd],
  )

  // periodic report + ended
  useEffect(() => {
    engine.onEnded = () => {
      const result = finishRef.current()
      if (result) {
        setScoreResult(result)
        // Record it on the leaderboard, then add the rank to the overlay.
        api
          .submitScore({ songId: result.song.id, score: result.score, tolerance: result.tolerance, singer: result.singer })
          .then((r) =>
            setScoreResult((cur) => (cur?.id === result.id ? { ...cur, rank: r.rank, best: r.best, plays: r.plays } : cur)),
          )
          .catch(() => {})
      }
      report()
      sendMessage({ type: 'ended' })
    }
    const t = setInterval(report, 1000)
    return () => {
      clearInterval(t)
      engine.onEnded = null
    }
  }, [engine, report])

  // keyboard shortcuts (TV remote / keyboard)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return
      if (e.ctrlKey || e.metaKey || e.altKey) return
      const st = useApp.getState().state
      const p = st.player
      switch (e.key) {
        case ' ':
          e.preventDefault()
          sendCommand({ action: 'toggle' })
          break
        case 'ArrowLeft':
          sendCommand({ action: 'seek', position: Math.max(0, engine.position() - 5) })
          break
        case 'ArrowRight':
          sendCommand({ action: 'seek', position: engine.position() + 5 })
          break
        case 'ArrowUp':
          e.preventDefault()
          sendCommand({ action: 'set', musicVolume: Math.min(1, Math.round((p.musicVolume + 0.05) * 100) / 100) })
          break
        case 'ArrowDown':
          e.preventDefault()
          sendCommand({ action: 'set', musicVolume: Math.max(0, Math.round((p.musicVolume - 0.05) * 100) / 100) })
          break
        case 'n':
        case 'N':
          sendCommand({ action: 'next' })
          break
        case 'm':
        case 'M':
          sendCommand({ action: 'set', displayMode: p.displayMode === 'mv' ? 'stage' : 'mv' })
          break
        case 'v':
        case 'V': {
          // cycles 伴唱 → 领唱 → 原唱
          const t = p.current ? st.tracks[p.current.song.id] : undefined
          if (!t?.hasStems) break
          const mode: VocalMode = p.trackMode === 'original' ? 'original' : p.leadVocal ? 'lead' : 'karaoke'
          const nextMode: VocalMode = mode === 'karaoke' ? 'lead' : mode === 'lead' ? 'original' : 'karaoke'
          sendCommand({ action: 'set', ...vocalModeCommand(nextMode) })
          break
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [engine])

  const getMs = useCallback(() => engine.position() * 1000, [engine])
  const getPos = useCallback(() => engine.position(), [engine])
  // Audio of the current song is loaded (during a key change the old pitch keeps playing until the swap).
  const playingAudio =
    !!songKey && engine.hasTrack && engine.loadedKey.startsWith(songKey) && (loadState === 'ready' || loadState === 'loading')
  const slowLoad = useDelayedFlag(loadState === 'loading', 500)
  // Key of the audio actually playing (a new key takes a few seconds to render on the server).
  const appliedKey = engine.loadedKey.startsWith(songKey) ? Number(engine.loadedKey.split('|')[2]) : player.key
  const showPreparing = !playingAudio && (!ready || loadState !== 'loading' || slowLoad)

  // "接下来" side panel, decided purely by the playback position (so seeking back hides it):
  // hidden before 85 % of the song, then 30 s shown / 30 s hidden, repeating.
  const [upNext, setUpNext] = useState(false)
  useEffect(() => {
    setUpNext(false)
    if (!playingAudio) return
    const check = () => {
      const show = engine.hasTrack && upNextVisible(engine.position(), engine.duration)
      setUpNext((v) => (v === show ? v : show))
    }
    check()
    const t = window.setInterval(check, 250)
    return () => window.clearInterval(t)
  }, [playingAudio, engine, songKey])

  const scoringAllowed = settings?.scoringEnabled ?? true
  const scoreTolerance = settings?.scoreTolerance ?? DEFAULT_TOLERANCE
  const { data: lyricsData } = useQuery({
    queryKey: ['lyrics', cur?.song.id],
    queryFn: () => api.lyrics(cur!.song.id),
    enabled: !!cur,
    staleTime: Infinity,
  })

  // 领唱 segments: computed once the stems are decoded and the lyrics are known, snapped to the
  // actual lead vocal, then handed to the engine which schedules them on the audio clock.
  useEffect(() => {
    const ok = leadOn && loadState === 'ready' && !!lyricsData && hasLyrics(lyricsData) && engine.hasTrack
    leadCtx.current = { on: ok, lines: ok ? lyricsData!.lines : null }
    sectionLead.current = ok ? leadSegments(lyricsData!.lines, engine.vocalActivity()) : []
    applyLead()
  }, [engine, leadOn, loadState, lyricsData, loadKey, applyLead])
  const scoring = useScoring({
    engine,
    active: audible && scoreOn && scoringAllowed && playingAudio,
    songId: cur?.song.id ?? null,
    songKey,
    hasPitch: !!track?.hasPitch,
    pitchKey: appliedKey, // match the audio actually playing
    lines: lyricsData?.lines,
    tolerance: scoreTolerance,
  })
  finishRef.current = () => {
    const s = scoring.finish()
    return s !== null && cur
      ? { id: Date.now(), score: s, song: cur.song, singer: cur.addedBy, tolerance: scoreTolerance }
      : null
  }
  const laneShown = scoring.status === 'on'

  // idle auto-hide (only once a song is on screen and audio is unlocked)
  const { idle, holdRef, hoverRef } = useIdle(unlocked && !!cur)
  const uiShown = !idle

  // MV mode: show the title for the first ~5 s of each song
  const [titleShown, setTitleShown] = useState(true)
  useEffect(() => {
    setTitleShown(true)
    if (!playingAudio) return
    const t = window.setTimeout(() => setTitleShown(false), 5000)
    return () => window.clearTimeout(t)
  }, [songKey, playingAudio])

  const start = async () => {
    try {
      await engine.unlock()
      setUnlocked(true)
      wasActive.current = true
      // Starting this TV makes it the one that plays audio; any other TV goes silent.
      sendMessage({ type: 'claim' })
      document.documentElement.requestFullscreen?.().catch(() => {})
    } catch {
      setUnlocked(false)
    }
  }
  const takeOver = () => {
    wasActive.current = true
    sendMessage({ type: 'claim' })
  }

  const duration = useMemo(() => (playingAudio ? engine.duration : (cur?.song.duration ?? 0) / 1000), [playingAudio, engine, cur])
  const mvPreload = settings?.mvPreload ?? true
  const onMvMode = useCallback(
    (mode: 'synced' | 'free') => showOsd(mode === 'synced' ? 'MV 已对齐' : 'MV 独立播放', 'video'),
    [showOsd],
  )
  // Warm up the next song's MV once the current song is playing (when 预载 MV is on).
  const nextMvSong = mvPreload && playingAudio && queue[0] && queue[0].song.mvId > 0 ? queue[0].song : null
  const getSongDuration = useCallback(
    () => (engine.hasTrack ? engine.duration : (useApp.getState().state.player.current?.song.duration ?? 0) / 1000),
    [engine],
  )

  return (
    <div className={clsx('relative h-full min-h-[560px] w-full overflow-hidden bg-ink-2 text-fg select-none', idle && 'cursor-none')}>
      {mvMode && cur ? (
        <MvScreen
          key={cur.uid}
          song={cur.song}
          engine={engine}
          getSongDuration={getSongDuration}
          preload={mvPreload}
          onModeKnown={onMvMode}
        />
      ) : (
        <>
          {cur ? <Ambient song={cur.song} /> : <IdleAmbient />}
          {cur && playingAudio && cur.song.mvId > 0 && <MvBackdrop key={cur.song.id} song={cur.song} engine={engine} preload={mvPreload} />}
          <Vignette />
        </>
      )}

      {nextMvSong && <NextMvPreloader key={nextMvSong.id} song={nextMvSong} />}

      {!cur ? (
        <IdleScreen />
      ) : (
        <>
          {mvMode ? (
            <MvTitle song={cur.song} shown={titleShown || uiShown || !playingAudio} />
          ) : (
            <Header player={player} track={track} auxShown={uiShown} />
          )}

          {playingAudio ? (
            mvMode ? (
              <TwoLineLyrics songId={cur.song.id} getMs={getMs} raised={uiShown} />
            ) : (
              <main
                className={clsx(
                  'absolute inset-x-0 top-[27vh] flex items-center justify-center transition-[bottom] duration-500',
                  laneShown ? 'bottom-[38vh]' : 'bottom-[26vh]',
                )}
              >
                <LyricsView songId={cur.song.id} getMs={getMs} song={cur.song} />
              </main>
            )
          ) : (
            showPreparing && (
              <PreparingScreen song={cur.song} track={track} loading={loadState === 'loading'} loadError={loadError} />
            )
          )}

          {laneShown && <LineRatingPop rating={scoring.lineRating} />}
          {mvMode && laneShown && (
            <div className="absolute top-[4.5vh] left-1/2 w-[36vw] -translate-x-1/2">
              <PitchLane lane={scoring.lane} getTime={getPos} score={scoring.score} compact />
            </div>
          )}
          {/* Scan-to-request QR: top right, hidden with the rest of the UI when idle. */}
          {mvMode && (
            <div className={clsx('absolute top-[4.5vh] right-[3.75vw]', fadeCls(uiShown))}>
              <QrCard />
            </div>
          )}
          {playingAudio && !player.playing && <PausedBadge />}

          <footer className="absolute right-[3.75vw] bottom-[5.2vh] left-[3.75vw] flex flex-col gap-5">
            {!mvMode && laneShown && <PitchLane lane={scoring.lane} getTime={getPos} score={scoring.score} />}
            <ControlsArea holdRef={holdRef} hoverRef={hoverRef} shown={uiShown}>
              <div className="flex min-w-0 flex-1 flex-col gap-6">
                <Progress getPos={getPos} duration={duration} />
                <Controls
                  player={player}
                  hasStems={hasStems}
                  keyPending={playingAudio && appliedKey !== player.key}
                  extra={
                    scoringAllowed && (
                      <ScoreToggle
                        on={scoreOn}
                        onToggle={toggleScore}
                        hasPitch={!!track?.hasPitch}
                        status={scoring.status}
                        micError={scoring.micError}
                        pitchError={scoring.pitchError}
                      />
                    )
                  }
                />
              </div>
            </ControlsArea>
          </footer>
        </>
      )}

      <UpNextPanel shown={upNext && !!cur && !scoreResult && queue.length > 0} mvMode={mvMode} />
      <Osd msg={osd} />
      <ScoreOverlay result={scoreResult} onDone={clearScoreResult} />

      {!connected && (
        <div className="glass absolute top-4 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full px-4 py-2 text-sm text-warn">
          <Spinner size={14} /> 与主机断开，正在重连…
        </div>
      )}

      <AnimatePresence>
        {!unlocked && (
          <motion.div
            initial={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.4 }}
            className="absolute inset-0 z-40 flex items-center justify-center bg-ink-2/80 backdrop-blur-md"
          >
            <button
              type="button"
              onClick={start}
              autoFocus
              className="group flex flex-col items-center gap-6 rounded-[32px] p-10 text-center"
            >
              <span className="flex h-28 w-28 items-center justify-center rounded-full bg-accent text-accent-ink shadow-[0_20px_60px_rgba(255,77,126,0.55)] transition-transform group-hover:scale-105">
                <Icon name="play" size={48} />
              </span>
              <span className="text-[clamp(28px,2.6vw,48px)] font-black">点击开始 KTV</span>
            </button>
          </motion.div>
        )}
        {unlocked && tvActive === false && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
            className="absolute inset-0 z-40 flex items-center justify-center bg-ink-2/85 backdrop-blur-md"
          >
            <div className="flex flex-col items-center gap-6 p-10 text-center">
              <span className="flex h-24 w-24 items-center justify-center rounded-full bg-white/8 text-fg-2">
                <Icon name="volume" size={40} />
              </span>
              <span className="text-[clamp(26px,2.4vw,44px)] font-black">另一个主屏正在播放</span>
              <span className="max-w-[560px] text-base leading-7 text-muted">
                同一时间只有一个主屏发声，避免两个声音叠在一起。这个页面已静音。
              </span>
              <button
                type="button"
                onClick={takeOver}
                autoFocus
                className="mt-2 flex h-14 items-center gap-2 rounded-2xl bg-accent px-7 text-lg font-bold text-accent-ink shadow-[0_14px_40px_rgba(255,77,126,0.45)] transition-transform hover:scale-105"
              >
                <Icon name="play" size={22} />
                在这里播放
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

/** Seconds before the end of a song when the "接下来" panel slides in. */
/** The "接下来" panel only appears after this fraction of the song… */
const UP_NEXT_FROM = 0.85
/** …and then alternates: shown for UP_NEXT_ON seconds, hidden for UP_NEXT_OFF seconds. */
const UP_NEXT_ON = 30
const UP_NEXT_OFF = 30

/** Always shown during the final seconds, whatever the 30 s on / off cycle says. */
const UP_NEXT_FINAL = 10

/** Whether the "接下来" panel should be visible at `pos` seconds of a `duration`-second song. */
function upNextVisible(pos: number, duration: number): boolean {
  if (!(duration > 0)) return false
  const since = pos - duration * UP_NEXT_FROM
  if (since < 0) return false
  if (duration - pos <= UP_NEXT_FINAL) return true
  return since % (UP_NEXT_ON + UP_NEXT_OFF) < UP_NEXT_ON
}
const UP_NEXT_MAX = 5

/**
 * Right-edge panel listing the next songs (and who requested them) near the end of a song,
 * so the next singers can get ready. Ignores idle auto-hide. In MV mode it sits higher so it
 * never covers the two lyric lines at the bottom.
 */
function UpNextPanel({ shown, mvMode }: { shown: boolean; mvMode: boolean }) {
  const queue = useApp((s) => s.state.queue)
  const tracks = useApp((s) => s.state.tracks)
  const reduce = useReducedMotion()
  const items = queue.slice(0, UP_NEXT_MAX)
  const more = queue.length - items.length
  return (
    <AnimatePresence>
      {shown && items.length > 0 && (
        <motion.aside
          key="up-next"
          aria-label="接下来"
          aria-live="polite"
          initial={reduce ? { opacity: 0 } : { opacity: 0, x: 48 }}
          animate={reduce ? { opacity: 1 } : { opacity: 1, x: 0 }}
          exit={reduce ? { opacity: 0 } : { opacity: 0, x: 48 }}
          transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
          className={clsx(
            'pointer-events-none absolute right-[2.6vw] z-20 flex w-[min(420px,28vw)] min-w-[300px] flex-col',
            // Stage: between the header and the control bar. MV: clear of the bottom lyric lines.
            mvMode ? 'top-[13vh] bottom-[34vh]' : 'top-[29vh] bottom-[27vh]',
            'justify-center',
          )}
        >
          <div className="glass flex max-h-full min-h-0 flex-col gap-3 overflow-hidden rounded-[28px] p-4 shadow-[0_30px_80px_rgba(0,0,0,0.55)]">
            <div className="flex shrink-0 items-center justify-between px-1">
              <span className="flex items-center gap-2 text-[15px] font-bold tracking-[0.18em] whitespace-nowrap text-fg">
                <Icon name="list" size={18} className="text-accent" />
                接下来
              </span>
              <span className="text-[13px] whitespace-nowrap text-muted">已点 {queue.length} 首</span>
            </div>
            <ol className="m-0 flex min-h-0 list-none flex-col gap-1.5 overflow-hidden p-0 [mask-image:linear-gradient(180deg,#000_85%,transparent)]">
              {items.map((item, i) => {
                const first = i === 0
                const status = deriveStatus(item.song, tracks[item.song.id], true)
                return (
                  <motion.li
                    key={item.uid}
                    initial={reduce ? false : { opacity: 0, x: 24 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: reduce ? 0 : 0.08 + i * 0.05, duration: 0.35 }}
                    className={clsx(
                      'flex shrink-0 items-center gap-3 rounded-2xl',
                      first
                        ? 'border border-[rgba(255,77,126,0.45)] bg-[linear-gradient(135deg,rgba(255,77,126,0.24),rgba(123,47,247,0.16))] p-3 shadow-[0_0_30px_rgba(255,77,126,0.22)]'
                        : 'px-3 py-2',
                    )}
                  >
                    {first ? (
                      <Cover song={item.song} px={160} className="h-14 w-14 rounded-xl" />
                    ) : (
                      <span className="num w-6 shrink-0 text-center text-[15px] text-subtle">{i + 1}</span>
                    )}
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      {first && (
                        <span className="text-xs font-semibold tracking-[0.14em] whitespace-nowrap text-[#FFC2D1]">
                          下一首
                        </span>
                      )}
                      <span className={clsx('truncate font-semibold', first ? 'text-[19px]' : 'text-[16px]')}>
                        {item.song.name}
                      </span>
                      <span className="truncate text-[13px] text-fg-2">
                        {artistsText(item.song)}
                        {item.addedBy && <span className="text-[#FFC2D1]"> · 由 {item.addedBy} 点歌</span>}
                      </span>
                    </div>
                    {first && (
                      <span className="shrink-0">
                        <StatusPill status={status} />
                      </span>
                    )}
                  </motion.li>
                )
              })}
            </ol>
            {more > 0 && <div className="shrink-0 px-1 text-[13px] whitespace-nowrap text-muted">还有 {more} 首…</div>}
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  )
}

/** Stays on screen while paused (even when the controls are hidden), so a paused TV never looks frozen. */
function PausedBadge() {
  return (
    <div className="pointer-events-none absolute top-1/2 left-1/2 z-20 -translate-x-1/2 -translate-y-1/2" aria-live="polite">
      <div className="glass flex items-center gap-4 rounded-full py-4 pr-8 pl-4 shadow-[0_20px_60px_rgba(0,0,0,0.5)]">
        <span className="flex h-14 w-14 items-center justify-center rounded-full bg-accent text-accent-ink">
          <Icon name="pause" size={26} />
        </span>
        <span className="text-[28px] font-bold">已暂停</span>
      </div>
    </div>
  )
}

/** Footer control bar that fades out when idle; hovering it keeps it awake. */
function ControlsArea({
  holdRef,
  hoverRef,
  shown,
  children,
}: {
  holdRef: MutableRefObject<HTMLDivElement | null>
  hoverRef: MutableRefObject<boolean>
  shown: boolean
  children: ReactNode
}) {
  return (
    <div
      ref={holdRef}
      onPointerEnter={() => (hoverRef.current = true)}
      onPointerLeave={() => (hoverRef.current = false)}
      className={clsx('flex items-end gap-10', fadeCls(shown))}
    >
      {children}
    </div>
  )
}
