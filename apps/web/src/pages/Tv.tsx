import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AnimatePresence, motion } from 'motion/react'
import clsx from 'clsx'
import type { DisplayMode, LyricLine } from '@shared/types'
import { toServerTime } from '../lib/clock'
import { useIdleMusic } from '../player/idleMusic'
import { api, mediaUrl } from '../lib/api'
import { fmtTime } from '../lib/format'
import { useDebounced, useSettings } from '../lib/hooks'
import { hasLyrics } from '../lib/lyrics'
import { leadSegments, mergeSegments, seekLeadSegments, type LeadSegment } from '../lib/leadVocal'
import { AudioEngine } from '../player/engine'
import { MirrorClock, type PlaybackClock } from '../lib/playbackSync'
import { useScoring } from '../player/useScoring'
import { DEFAULT_TOLERANCE } from '../player/scoring'
import { connect, livePosition, onCommand, sendCommand, sendMessage, useApp } from '../store/app'
import { Icon } from '../components/icons'
import { Spinner } from '../components/ui'
import { PitchLane } from '../components/PitchLane'
import { LineRatingPop, ScoreOverlay, type ScoreResult } from '../components/ScoreOverlay'
import { vocalModeCommand, type VocalMode } from '../components/PlayerModes'
import { Ambient, IdleAmbient, Vignette } from './tv/background'
import { Controls, ControlsArea, Header, MvTitle, Progress, QrCard, SCORE_PREF, ScoreToggle, fadeCls, readScorePref, readScreenVolume, saveScreenVolume, scoreHint, singerOf } from './tv/chrome'
import { LyricsView, TwoLineLyrics } from './tv/lyrics'
import { MvBackdrop, MvScreen, NextMvPreloader } from './tv/mv'
import { IdleScreen, Osd, PreparingScreen, START_HOLD_MS, START_MAX_WAIT_MS, StartingScreen, UpNextPanel, upNextVisible, useDelayedFlag, useIdle, useOsd } from './tv/screens'

/** The engine's load key is `uid|epoch|key|s|o`: queue entry, 重唱 round, pitch, stems or original. */
function parseLoadKey(k: string) {
  const [uid = '', epoch = '0', key = '0'] = k.split('|')
  return { uid, epoch: Number(epoch), key: Number(key) }
}

export default function Tv() {
  const engineRef = useRef<AudioEngine | null>(null)
  if (!engineRef.current) engineRef.current = new AudioEngine()
  const engine = engineRef.current
  // 待机音乐 plays through its own engine on the same AudioContext (one unlock for both).
  const idleEngineRef = useRef<AudioEngine | null>(null)
  if (!idleEngineRef.current) idleEngineRef.current = new AudioEngine(engine)
  const idleEngine = idleEngineRef.current
  const [unlocked, setUnlocked] = useState(false)
  const [loadState, setLoadState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  /** A fresh song whose audio is loaded but which hasn't started yet (即将开始 card). */
  /** The 点击开始 overlay is up (keyboard Space / Enter start the screen). */
  const needsStartRef = useRef(false)
  const [startGate, setStartGate] = useState<{ key: string; since: number } | null>(null)
  const startGateRef = useRef(startGate)
  startGateRef.current = startGate
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
  // Every TV page is a 大屏; exactly one is the 主屏 (plays, reports, takes commands, its mode is
  // what remotes control). Any other 大屏 follows the 主屏's reports: same song, lyrics and MV,
  // muted unless 多大屏播放 is on and it was unmuted here.
  const isMain = tvActive === true
  const mirror = tvActive === false
  const rawSync = useApp((s) => s.sync)
  const mirrorClockRef = useRef<MirrorClock | null>(null)
  if (!mirrorClockRef.current) mirrorClockRef.current = new MirrorClock()
  const mirrorClock = mirrorClockRef.current
  useEffect(() => {
    if (rawSync) mirrorClock.update(rawSync)
  }, [rawSync, mirrorClock])
  // The 主屏 holds the song on 即将开始: so does this one (from when it first heard about it).
  const mirrorStarting = mirror && !!rawSync?.starting && rawSync.uid === useApp.getState().state.player.current?.uid
  const [mirrorStartingSince, setMirrorStartingSince] = useState<number | null>(null)
  useEffect(() => {
    setMirrorStartingSince((v) => (mirrorStarting ? (v ?? performance.now()) : null))
  }, [mirrorStarting])
  const { data: settings } = useSettings()
  const unifiedMode = settings?.multiScreenSync ?? false
  const multiAudio = settings?.multiScreenAudio ?? false
  const [muted, setMuted] = useState(true)
  // 多大屏播放 turned off: every 大屏 except the 主屏 goes silent (turning it on unmutes nothing).
  useEffect(() => {
    if (!multiAudio) setMuted(true)
  }, [multiAudio])
  // A 主屏 that hands over keeps sounding only if 多大屏播放 allows it.
  const wasMain = useRef(isMain)
  useEffect(() => {
    if (wasMain.current && tvActive === false) setMuted(!multiAudio)
    wasMain.current = tvActive === true
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tvActive])
  const following = mirror && multiAudio && !muted && unlocked
  const audible = unlocked && (isMain || following)
  // A 大屏 that isn't the 主屏 has its own volume once unmuted (songs and 待机音乐 alike); the
  // 主屏 always plays at the shared levels.
  const [screenVolume, setScreenVolumeState] = useState(readScreenVolume)
  const setScreenVolume = useCallback((v: number) => {
    setScreenVolumeState(v)
    saveScreenVolume(v)
  }, [])
  const ownVolume = mirror ? screenVolume : 1
  useEffect(() => {
    engine.setMaster(ownVolume)
  }, [engine, ownVolume])
  const isMainRef = useRef(isMain)
  isMainRef.current = isMain
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
  const clearScoreResult = useCallback(() => {
    setScoreResult(null)
    setStartGate((g) => (g ? { ...g, since: performance.now() } : g))
  }, [])

  useEffect(() => connect('tv'), [])
  useEffect(() => {
    document.title = '大屏 · Netease KTV'
  }, [])

  const report = useCallback(() => {
    if (!engine.hasTrack || useApp.getState().tvActive !== true) return
    // Stamp the report with when this sample comes out of the speakers (server clock), so 耳返
    // phones can play in step. uid / epoch say which song the audio belongs to.
    const out = engine.outputClock()
    const at = toServerTime(out.perf)
    const { uid, epoch } = parseLoadKey(engine.loadedKey)
    sendMessage({
      type: 'report',
      position: out.position,
      playing: engine.playing,
      ...(at !== null ? { at } : {}),
      ...(uid ? { uid, epoch } : {}),
      // Holding at 0 on 即将开始: the other 大屏 show the card too instead of paused lyrics.
      ...(startGateRef.current && !engine.playing ? { starting: true } : {}),
    })
  }, [engine])

  // Keep audio on this TV across a brief reconnect: if it was the active TV, claim it back.
  const wasActive = useRef(false)
  const connectedAt = useRef(0)
  useEffect(() => {
    if (!connected) return
    connectedAt.current = Date.now()
    if (unlocked && wasActive.current) sendMessage({ type: 'claim', displayMode: displayModeRef.current })
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
  // Display mode: the sound screen uses (and remotes control) the synced one; a silent screen
  // keeps its own, starting from whatever it showed when it stopped being the sound screen.
  const storeReady = useApp((s) => s.ready)
  const syncedMode: DisplayMode = player.displayMode ?? 'stage'
  const [localMode, setLocalMode] = useState<DisplayMode | null>(null)
  useEffect(() => {
    if (!storeReady) return
    if (tvActive !== false || unifiedMode || localMode === null) setLocalMode(syncedMode)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeReady, tvActive, syncedMode, unifiedMode])
  const ownMode = mirror && !unifiedMode
  const displayMode: DisplayMode = ownMode ? (localMode ?? syncedMode) : syncedMode
  const ownModeRef = useRef(ownMode)
  ownModeRef.current = ownMode
  const displayModeRef = useRef(displayMode)
  displayModeRef.current = displayMode
  const mvMode = displayMode === 'mv'
  mirrorClock.uid = cur?.uid ?? null
  mirrorClock.epoch = player.epoch
  mirrorClock.duration = (cur?.song.duration ?? 0) / 1000
  const clock: PlaybackClock = mirror ? mirrorClock : engine
  const clockRef = useRef(clock)
  clockRef.current = clock
  const mirrorRef = useRef(mirror)
  mirrorRef.current = mirror
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
        // A screen taking over from another one continues exactly where the mirror shows it.
        const resumeAt = sameSong
          ? engine.lastPosition
          : fromServer
            ? mirrorClock.hasTrack
              ? mirrorClock.position()
              : livePosition(p)
            : 0
        const resume = sameSong ? engine.lastPlaying : fromServer ? p.playing : true
        if (!sameSong) seekLead.current = []
        if (!isMainRef.current) return // following the 主屏: the follow loop starts it in step
        if (!sameSong && !fromServer) {
          // A fresh song: hold it at 0 on the 即将开始 card until the lyrics are in, the audio
          // clock runs and the output has had a moment (the start-gate effect below plays it).
          engine.seek(0)
          const gate = { key: loadKey, since: performance.now() }
          setStartGate(gate)
          startGateRef.current = gate
          report()
          return
        }
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

  const { msg: osd, show: showOsd } = useOsd(player, !ownMode, !!scoreResult)
  // 待机音乐 while nothing is queued: the 主屏 plays it, the other 大屏 show and follow it.
  const idleSong = useIdleMusic({
    engine: idleEngine,
    main: isMain,
    audible,
    active: storeReady && !cur,
    volume: player.idleVolume * ownVolume,
  })

  // server-forwarded commands
  useEffect(
    () =>
      onCommand((c) => {
        if (!engine.hasTrack) return
        if (startGateRef.current) setStartGate(null)
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

  // A following 大屏: start on the 主屏's timeline and re-align when it drifts. Only hard re-syncs
  // (no rate nudging), so the 领唱 gain schedule stays sample-exact; audio clocks drift a few ms
  // per minute, so that is rare. A jump of a second or more is a seek: 领唱 helps back in.
  useEffect(() => {
    if (!following || loadState !== 'ready') return
    let off = 0
    const tick = () => {
      if (!engine.hasTrack || !mirrorClock.hasTrack) {
        if (engine.playing) engine.pause()
        return
      }
      if (!mirrorClock.playing) {
        if (engine.playing) engine.pause()
        if (Math.abs(engine.position() - mirrorClock.position()) > 0.05) engine.seek(mirrorClock.position())
        return
      }
      const target = (perf: number) => mirrorClock.positionAt(perf)
      if (!engine.playing) {
        engine.playAligned(target)
        off = 0
        return
      }
      const out = engine.outputClock()
      const want = target(out.perf)
      if (!Number.isFinite(want)) return
      const drift = out.position - want
      if (Math.abs(drift) > 1) leadAfterSeek(want)
      off = Math.abs(drift) > 0.035 ? off + 1 : 0
      if (Math.abs(drift) > 0.2 || off >= 2) {
        engine.playAligned(target)
        off = 0
      }
    }
    tick()
    const t = window.setInterval(tick, 250)
    return () => window.clearInterval(t)
  }, [following, loadState, engine, mirrorClock, leadAfterSeek])

  // periodic report + ended
  useEffect(() => {
    engine.onEnded = () => {
      // Only the 主屏 ends songs and records scores; a following 大屏 just stops.
      if (!isMainRef.current) return
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
      if (needsStartRef.current && (e.key === ' ' || e.key === 'Enter')) {
        e.preventDefault()
        void startRef.current()
        return
      }
      if (target?.tagName === 'BUTTON' && (e.key === ' ' || e.key === 'Enter')) return
      const st = useApp.getState().state
      const p = st.player
      switch (e.key) {
        case ' ':
          e.preventDefault()
          sendCommand({ action: 'toggle' })
          break
        case 'ArrowLeft':
          sendCommand({ action: 'seek', position: Math.max(0, clockRef.current.position() - 5) })
          break
        case 'ArrowRight':
          sendCommand({ action: 'seek', position: clockRef.current.position() + 5 })
          break
        case 'ArrowUp':
        case 'ArrowDown': {
          e.preventDefault()
          // On the idle page the keys set the 待机音乐 volume.
          const d = e.key === 'ArrowUp' ? 0.05 : -0.05
          const step = (v: number) => Math.max(0, Math.min(1, Math.round((v + d) * 100) / 100))
          if (p.current) sendCommand({ action: 'set', musicVolume: step(p.musicVolume) })
          else sendCommand({ action: 'set', idleVolume: step(p.idleVolume) })
          break
        }
        case 'n':
        case 'N':
          sendCommand({ action: 'next' })
          break
        case 'm':
        case 'M':
          if (ownModeRef.current) setLocalMode(displayModeRef.current === 'mv' ? 'stage' : 'mv')
          else sendCommand({ action: 'set', displayMode: p.displayMode === 'mv' ? 'stage' : 'mv' })
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

  const getMs = useCallback(() => clockRef.current.position() * 1000, [])
  const getPos = useCallback(() => clockRef.current.position(), [])
  // The current song is on: its audio is loaded here (during a key change the old pitch keeps
  // playing until the swap), or, on a silent screen, the sound screen reports playing it.
  const playingAudio = mirror
    ? !!songKey && mirrorClock.hasTrack
    : !!songKey && engine.hasTrack && engine.loadedKey.startsWith(songKey) && (loadState === 'ready' || loadState === 'loading')
  const slowLoad = useDelayedFlag(loadState === 'loading', 500)
  // Key of the audio actually playing (a new key takes a few seconds to render on the server).
  const appliedKey = engine.loadedKey.startsWith(songKey) ? parseLoadKey(engine.loadedKey).key : player.key
  const showPreparing = !playingAudio && (mirror || !ready || loadState !== 'loading' || slowLoad)

  // "接下来" side panel, decided purely by the playback position (so seeking back hides it):
  // hidden before 85 % of the song, then 30 s shown / 30 s hidden, repeating.
  const [upNext, setUpNext] = useState(false)
  useEffect(() => {
    setUpNext(false)
    if (!playingAudio) return
    const check = () => {
      const c = clockRef.current
      const show = c.hasTrack && upNextVisible(c.position(), c.duration)
      setUpNext((v) => (v === show ? v : show))
    }
    check()
    const t = window.setInterval(check, 250)
    return () => window.clearInterval(t)
  }, [playingAudio, songKey])

  const scoringAllowed = settings?.scoringEnabled ?? true
  const scoreTolerance = settings?.scoreTolerance ?? DEFAULT_TOLERANCE
  const { data: lyricsData, isPending: lyricsPending } = useQuery({
    queryKey: ['lyrics', cur?.song.id],
    queryFn: () => api.lyrics(cur!.song.id),
    enabled: !!cur,
    staleTime: Infinity,
  })

  // Keep the audio output awake while this 大屏 makes sound, so a song never starts into a
  // sleeping TV / amplifier / Bluetooth speaker.
  useEffect(() => {
    engine.keepAwake(audible)
    return () => engine.keepAwake(false)
  }, [engine, audible])

  // Start gate: play a fresh song once its lyrics are loaded (or failed), the audio clock is
  // running and the card has been up for START_HOLD_MS. Never longer than START_MAX_WAIT_MS.
  useEffect(() => {
    if (!startGate) return
    // Another song, or no longer the 主屏: the hold is over. A key change during the hold reloads
    // the same song (it stays at 0, paused): keep holding and start it once the new key is in.
    if (!songKey || !startGate.key.startsWith(songKey) || !isMain) {
      setStartGate(null)
      return
    }
    if (startGate.key !== loadKey) {
      setStartGate({ ...startGate, key: loadKey })
      return
    }
    if (loadState !== 'ready') return
    // The score card of the last song is still up: start once it has gone.
    if (scoreResult) return
    const waited = performance.now() - startGate.since
    if (lyricsPending && waited < START_MAX_WAIT_MS) {
      const t = window.setTimeout(() => setStartGate((g) => (g ? { ...g } : g)), 250)
      return () => window.clearTimeout(t)
    }
    let cancelled = false
    const t = window.setTimeout(
      async () => {
        const running = await engine.ensureRunning()
        if (cancelled) return
        setStartGate(null)
        if (!running) {
          setUnlocked(false) // the 点击开始 overlay asks for a click to allow sound
          return
        }
        engine.play(0)
        report()
      },
      Math.max(0, START_HOLD_MS - waited),
    )
    return () => {
      cancelled = true
      window.clearTimeout(t)
    }
  }, [startGate, songKey, loadKey, loadState, isMain, lyricsPending, engine, report, scoreResult])

  // 领唱 segments: computed once the stems are decoded and the lyrics are known, snapped to the
  // actual lead vocal, then handed to the engine which schedules them on the audio clock.
  // Switching to 领唱 mid-song: the next two lines get the original vocal too, so the change is
  // heard right away instead of at the next section.
  const leadWas = useRef<{ on: boolean; key: string }>({ on: false, key: '' })
  useEffect(() => {
    const ok = leadOn && loadState === 'ready' && !!lyricsData && hasLyrics(lyricsData) && engine.hasTrack
    leadCtx.current = { on: ok, lines: ok ? lyricsData!.lines : null }
    sectionLead.current = ok ? leadSegments(lyricsData!.lines, engine.vocalActivity()) : []
    const switchedOn = ok && !leadWas.current.on && leadWas.current.key === loadKey
    if (switchedOn) seekLead.current = seekLeadSegments(lyricsData!.lines, engine.vocalActivity(), engine.position(), true)
    else if (!ok) seekLead.current = []
    // Remember only settled states (audio and lyrics both in), so a song that starts with 领唱
    // already on is not mistaken for a switch.
    if (loadState === 'ready' && lyricsData) leadWas.current = { on: ok, key: loadKey }
    applyLead()
  }, [engine, leadOn, loadState, lyricsData, loadKey, applyLead])
  const scoring = useScoring({
    engine,
    active: unlocked && isMain && scoreOn && scoringAllowed && playingAudio,
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
  // Only the 主屏 scores; 'loading' is not a problem worth a persistent note.
  const scoreWarn =
    scoringAllowed && isMain && unlocked && playingAudio && scoring.status !== 'loading'
      ? scoreHint({ on: scoreOn, hasPitch: !!track?.hasPitch, status: scoring.status, micError: scoring.micError, pitchError: scoring.pitchError })
      : null

  // idle auto-hide (only once a song is on screen and audio is unlocked)
  const { idle, holdRef, hoverRef } = useIdle((unlocked || mirror) && !!cur)
  const uiShown = !idle

  // The QR code, 下一首 card and queue count normally hide with the controls. Bring them back
  // for a few seconds when a new song starts or someone adds a song, so the room sees them.
  const [auxPeek, setAuxPeek] = useState(false)
  const queueLen = queue.length
  const prevQueueLen = useRef(queueLen)
  useEffect(() => {
    if (cur) setAuxPeek(true)
  }, [cur?.uid]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (queueLen > prevQueueLen.current) setAuxPeek(true)
    prevQueueLen.current = queueLen
  }, [queueLen])
  useEffect(() => {
    if (!auxPeek) return
    const t = window.setTimeout(() => setAuxPeek(false), 8000)
    return () => window.clearTimeout(t)
  }, [auxPeek])
  const upNextShown = upNext && !!cur && !scoreResult && queueLen > 0

  // MV mode: show the title for the first ~5 s of each song
  const [titleShown, setTitleShown] = useState(true)
  useEffect(() => {
    setTitleShown(true)
    if (!playingAudio) return
    const t = window.setTimeout(() => setTitleShown(false), 5000)
    return () => window.clearTimeout(t)
  }, [songKey, playingAudio])

  /** Allow sound on this page (needs a click / key press). False when the browser refused. */
  const unlockAudio = async () => {
    try {
      await engine.unlock()
      setUnlocked(true)
      return true
    } catch {
      return false
    }
  }
  /** This 大屏 becomes the 主屏: it plays the audio and takes the commands; any other one goes silent. */
  const claimMain = () => {
    wasActive.current = true
    sendMessage({ type: 'claim', displayMode: displayModeRef.current })
  }
  const start = async () => {
    if (!(await unlockAudio())) {
      setUnlocked(false)
      return
    }
    claimMain()
    document.documentElement.requestFullscreen?.().catch(() => {})
  }
  const startRef = useRef(start)
  startRef.current = start
  needsStartRef.current = !unlocked && tvActive === true

  /** 取消静音 / 静音 on a 大屏 that isn't the 主屏 (多大屏播放). The click also unlocks its audio. */
  const toggleMute = async () => {
    if (muted && !(await unlockAudio())) return
    setMuted((m) => !m)
  }
  /** 设为主屏: this 大屏 becomes the 主屏 (the click also unlocks its audio). */
  const takeOver = async () => {
    await unlockAudio() // if refused, the 点击开始 overlay asks for a click
    claimMain()
  }

  const duration = useMemo(
    () => (playingAudio && !mirror ? engine.duration : (cur?.song.duration ?? 0) / 1000),
    [playingAudio, mirror, engine, cur],
  )
  const mvPreload = settings?.mvPreload ?? true
  const onMvMode = useCallback(
    (mode: 'synced' | 'free') => showOsd(mode === 'synced' ? 'MV 已对齐' : 'MV 未对齐，从头同步播放', 'video'),
    [showOsd],
  )
  // Warm up the next song's MV once the current song is playing (when 预载 MV is on).
  const nextMvSong = mvPreload && playingAudio && queue[0] && queue[0].song.mvId > 0 ? queue[0].song : null
  const getSongDuration = useCallback(() => {
    const c = clockRef.current
    return c.hasTrack && c.duration > 0 ? c.duration : (useApp.getState().state.player.current?.song.duration ?? 0) / 1000
  }, [])

  return (
    <div className={clsx('tv-root relative h-full min-h-[560px] w-full overflow-hidden bg-ink-2 text-fg select-none', idle && 'cursor-none')}>
      {mvMode && cur ? (
        <MvScreen
          key={cur.uid}
          song={cur.song}
          engine={clock}
          getSongDuration={getSongDuration}
          preload={mvPreload}
          onModeKnown={onMvMode}
        />
      ) : (
        <>
          {cur ? <Ambient song={cur.song} /> : <IdleAmbient />}
          {cur && playingAudio && cur.song.mvId > 0 && <MvBackdrop key={cur.song.id} song={cur.song} engine={clock} preload={mvPreload} />}
          <Vignette />
        </>
      )}

      {nextMvSong && <NextMvPreloader key={nextMvSong.id} song={nextMvSong} />}

      {!cur ? (
        <IdleScreen
          onMakeMain={mirror ? takeOver : undefined}
          idleSong={idleSong}
          muted={mirror && multiAudio ? muted : undefined}
          onToggleMute={mirror && multiAudio ? toggleMute : undefined}
          volume={screenVolume}
          onVolume={setScreenVolume}
        />
      ) : (
        <>
          {mvMode ? (
            <MvTitle song={cur.song} singer={singerOf(cur.addedBy)} shown={titleShown || uiShown || !playingAudio} />
          ) : (
            <Header player={player} track={track} auxShown={uiShown || auxPeek} hideNext={upNextShown} />
          )}

          {startGate && isMain ? (
            <StartingScreen song={cur.song} singer={cur.addedBy} since={startGate.since} />
          ) : mirrorStartingSince !== null ? (
            <StartingScreen song={cur.song} singer={cur.addedBy} since={mirrorStartingSince} />
          ) : playingAudio ? (
            mvMode ? (
              <TwoLineLyrics songId={cur.song.id} getMs={getMs} raised={uiShown} />
            ) : (
              <main
                className={clsx(
                  // Clear of the header (≈140px + 5.2vh) and the footer (≈164px, ≈304px with the
                  // scoring lane) even on short screens; leave room on the right for 接下来.
                  'absolute inset-x-0 top-[max(27vh,200px)] flex items-center justify-center transition-[bottom,padding] duration-500',
                  laneShown ? 'bottom-[max(38vh,330px)]' : 'bottom-[max(26vh,190px)]',
                  upNextShown && 'pr-[calc(max(min(420px,28vw),300px)+3vw)]',
                )}
              >
                <LyricsView songId={cur.song.id} getMs={getMs} song={cur.song} compact={laneShown} />
              </main>
            )
          ) : (
            showPreparing && (
              <PreparingScreen
                song={cur.song}
                track={track}
                loading={loadState === 'loading'}
                loadError={loadError}
                onMakeMain={mirror ? takeOver : undefined}
              />
            )
          )}

          {laneShown && <LineRatingPop rating={scoring.lineRating} />}
          {mvMode && laneShown && (
            <div className="absolute top-[calc(4.5vh+var(--tb-h))] left-1/2 w-[36vw] -translate-x-1/2">
              <PitchLane lane={scoring.lane} getTime={getPos} score={scoring.score} compact />
            </div>
          )}
          {/* Scan-to-request QR: top right, hidden with the rest of the UI when idle. */}
          {mvMode && (
            <div className={clsx('absolute top-[calc(4.5vh+var(--tb-h))] right-[3.75vw]', fadeCls((uiShown || auxPeek) && !upNextShown))}>
              <QrCard />
            </div>
          )}

          <footer className="absolute right-[3.75vw] bottom-[5.2vh] left-[3.75vw] flex flex-col gap-5">
            {!mvMode && laneShown && <PitchLane lane={scoring.lane} getTime={getPos} score={scoring.score} />}
            <ControlsArea holdRef={holdRef} hoverRef={hoverRef} shown={uiShown}>
              <div className="flex min-w-0 flex-1 flex-col gap-6">
                <Progress getPos={getPos} duration={duration} />
                <Controls
                  player={player}
                  hasStems={hasStems}
                  keyPending={playingAudio && appliedKey !== player.key}
                  mirror={
                    mirror
                      ? {
                          displayMode,
                          // 多大屏协同: switching here switches every 大屏 (it is the shared mode).
                          setDisplayMode: ownMode ? setLocalMode : (m) => sendCommand({ action: 'set', displayMode: m }),
                          takeOver,
                          muted: multiAudio ? muted : undefined,
                          toggleMute: multiAudio ? toggleMute : undefined,
                          volume: screenVolume,
                          setVolume: setScreenVolume,
                        }
                      : undefined
                  }
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

      {scoreWarn && !uiShown && (
        <div className="glass pointer-events-none absolute bottom-[5.2vh] left-[3.75vw] z-10 flex max-w-[40vw] items-center gap-2 rounded-full px-4 py-2 text-[clamp(14px,0.9vw,18px)] text-warn">
          <Icon name="mic" size={16} className="shrink-0" />
          <span className="truncate">评分不可用：{scoreWarn}</span>
        </div>
      )}

      <UpNextPanel shown={upNextShown} mvMode={mvMode} />
      <Osd msg={osd} />
      <ScoreOverlay result={scoreResult} onDone={clearScoreResult} />

      {!connected && (
        <div className="glass absolute top-[calc(1rem+var(--tb-h))] left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full px-4 py-2 text-sm text-warn">
          <Spinner size={14} /> 与主机断开，正在重连…
        </div>
      )}

      <AnimatePresence>
        {!unlocked && tvActive === true && (
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
              <span className="text-[clamp(14px,1.1vw,20px)] text-fg-2">或按遥控器的确认键 / 回车</span>
            </button>
            <p className="absolute bottom-[6vh] left-1/2 m-0 -translate-x-1/2 text-center text-[clamp(14px,1.1vw,20px)] whitespace-nowrap text-muted">
              空格 播放/暂停 · N 切歌 · M 舞台/MV · V 伴唱/领唱/原唱 · ↑↓ 音量 · ←→ 快退/快进
            </p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
