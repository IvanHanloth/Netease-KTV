import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { LyricLine } from '@shared/types'
import { api } from '../lib/api'
import { currentLineIndex } from '../lib/lyrics'
import type { AudioEngine } from './engine'
import { MicPitch, type MicError } from './mic'
import { buildNotes, foldToRef, noteAt, rating, sampleRef, ScoreKeeper, type RatingTone, type RefNote } from './scoring'

export interface TracePoint {
  t: number
  m: number | null
}

/** Live data the pitch lane draws every frame (read through a ref, no React re-render). */
export interface LaneData {
  notes: RefNote[]
  keeper: ScoreKeeper
  trace: TracePoint[]
  key: number
}

export interface LineRating {
  id: number
  label: string
  tone: RatingTone
  score: number
}

const FRAME_MS = 25 // ~40 detections per second
const TRACE_SECONDS = 2.2

export function useScoring({
  engine,
  active,
  songId,
  songKey,
  hasPitch,
  pitchKey,
  lines,
}: {
  engine: AudioEngine
  /** Scoring switched on, allowed by settings, and audio is playing for this song. */
  active: boolean
  songId: number | null
  /** Changes whenever the song restarts (uid + epoch) — totals reset. */
  songKey: string
  hasPitch: boolean
  /** Current key shift in semitones. */
  pitchKey: number
  lines: LyricLine[] | undefined
}) {
  const wanted = active && hasPitch && songId !== null
  const { data: pitch, isError: pitchError } = useQuery({
    queryKey: ['pitch', songId],
    queryFn: () => api.pitch(songId!),
    enabled: wanted,
    staleTime: Infinity,
    retry: false,
  })
  const notes = useMemo(() => (pitch ? buildNotes(pitch) : []), [pitch])

  const micRef = useRef<MicPitch | null>(null)
  if (!micRef.current) micRef.current = new MicPitch()
  const mic = micRef.current
  const [micState, setMicState] = useState<'off' | 'starting' | 'on'>('off')
  const [micError, setMicError] = useState<MicError | null>(null)

  const lane = useRef<LaneData>({ notes: [], keeper: new ScoreKeeper(), trace: [], key: 0 })
  lane.current.notes = notes
  lane.current.key = pitchKey

  const [score, setScore] = useState(0)
  const [lineRating, setLineRating] = useState<LineRating | null>(null)
  const ratingId = useRef(0)
  const lastLine = useRef(-1)
  const linesRef = useRef(lines)
  linesRef.current = lines

  // Reset totals for every new song / restart.
  useEffect(() => {
    lane.current.keeper.reset()
    lane.current.trace = []
    lastLine.current = -1
    setScore(0)
    setLineRating(null)
  }, [songKey])

  // Microphone lifecycle: only held while scoring is actually wanted.
  useEffect(() => {
    if (!wanted || !engine.ctx) {
      mic.stop()
      setMicState('off')
      return
    }
    let cancelled = false
    setMicState('starting')
    setMicError(null)
    mic
      .start(engine.ctx)
      .then(() => {
        if (cancelled) mic.stop()
        else setMicState('on')
      })
      .catch((err: { code?: MicError }) => {
        if (cancelled) return
        setMicError(err?.code ?? 'unavailable')
        setMicState('off')
      })
    return () => {
      cancelled = true
    }
  }, [wanted, engine, mic])

  // Stop the mic when leaving the page.
  useEffect(() => () => mic.stop(), [mic])

  // Detection + scoring loop.
  useEffect(() => {
    if (micState !== 'on' || !pitch) return
    const keeper = lane.current.keeper
    const tick = setInterval(() => {
      if (!engine.playing) return
      const t = engine.position()
      const user = mic.read()
      const ref = sampleRef(pitch, t, lane.current.key)
      const pts = keeper.add(ref, user)
      if (pts !== null && pts >= 0.7) {
        const idx = noteAt(lane.current.notes, t)
        if (idx >= 0) keeper.hits.add(idx)
      }
      const m = user === null ? null : ref !== null ? foldToRef(user, ref) : user
      const trace = lane.current.trace
      trace.push({ t, m })
      // Drop old points (and points "from the future" after a backwards seek).
      while (trace.length && (trace[0]!.t < t - TRACE_SECONDS || trace[0]!.t > t + 0.1)) trace.shift()

      const ls = linesRef.current
      if (ls?.length) {
        const li = currentLineIndex(ls, t * 1000)
        if (li !== lastLine.current) {
          if (lastLine.current >= 0) {
            const s = keeper.endLine()
            if (s !== null) setLineRating({ id: ++ratingId.current, score: s, ...rating(s) })
          } else keeper.endLine()
          lastLine.current = li
        }
      }
    }, FRAME_MS)
    const ui = setInterval(() => setScore(keeper.score), 250)
    return () => {
      clearInterval(tick)
      clearInterval(ui)
    }
  }, [micState, pitch, engine, mic])

  /** Final result for the song, or null when too little was scored to mean anything. */
  const finish = useCallback((): number | null => {
    const k = lane.current.keeper
    return micState === 'on' && k.frames >= 200 ? k.score : null
  }, [micState])

  const status: 'off' | 'loading' | 'on' | 'error' = !wanted
    ? 'off'
    : micError || pitchError
      ? 'error'
      : micState === 'on' && pitch
        ? 'on'
        : 'loading'

  return { status, micError, pitchError, score, lineRating, lane, finish }
}
