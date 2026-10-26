import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { sendCommand } from '../store/app'
import type { MicError } from './mic'
import { DEFAULT_MIC, listMics, MicMixer, type MicInputInfo } from './micMixer'

/** This 大屏's microphone choices (the devices are this machine's, so they stay on it). */
interface MicPrefs {
  /** Input device ids; [DEFAULT_MIC] = the system default. */
  devices: string[]
  /** Per-device balance, 0..2 (1 = as is). */
  gains: Record<string, number>
}

const MIC_PREF = 'ktv.mic'
const DEFAULT_PREFS: MicPrefs = { devices: [DEFAULT_MIC], gains: {} }

function readPrefs(): MicPrefs {
  try {
    const p = { ...DEFAULT_PREFS, ...(JSON.parse(localStorage.getItem(MIC_PREF) || '{}') as Partial<MicPrefs>) }
    if (!Array.isArray(p.devices) || !p.devices.length) p.devices = [DEFAULT_MIC]
    return p
  } catch {
    return DEFAULT_PREFS
  }
}

export type MicStatus = 'off' | 'starting' | 'on' | 'error'

export interface MicControl {
  on: boolean
  setOn: (v: boolean) => void
  /** off: switched off or not the 主屏; error: no device could be opened. */
  status: MicStatus
  /** Why a device could not be opened. */
  errors: Map<string, MicError>
  /** Physical inputs (without the 系统默认 entry). Labels are empty before the first permission. */
  devices: MicInputInfo[]
  selected: string[]
  toggleDevice: (id: string) => void
  gains: Record<string, number>
  setGain: (id: string, g: number) => void
  /** Input level per open device (0..1). */
  levels: () => Map<string, number>
  /** The microphone mix for 耳返 phones (null while off). */
  stream: MediaStream | null
  /** Dry microphone sum for pitch detection (null while off). */
  tap: { ctx: AudioContext; node: AudioNode } | null
}

/**
 * The 主屏 microphone: `enabled` = this page may make sound (unlocked 主屏). `on` / `level` /
 * `reverb` are the shared player values (the 点歌台 and remotes set them too).
 */
export function useMicMixer({ enabled, on, level, reverb }: { enabled: boolean; on: boolean; level: number; reverb: number }): MicControl {
  const mixerRef = useRef<MicMixer | null>(null)
  if (!mixerRef.current) mixerRef.current = new MicMixer()
  const mixer = mixerRef.current
  if (import.meta.env.DEV) (window as unknown as { __ktvMic: MicMixer }).__ktvMic = mixer
  const [prefs, setPrefsState] = useState(readPrefs)
  const setPrefs = useCallback((patch: Partial<MicPrefs>) => {
    setPrefsState((p) => {
      const next = { ...p, ...patch }
      try {
        localStorage.setItem(MIC_PREF, JSON.stringify(next))
      } catch {
        /* storage unavailable */
      }
      return next
    })
  }, [])
  const [status, setStatus] = useState<MicStatus>('off')
  const [errors, setErrors] = useState<Map<string, MicError>>(() => new Map())
  const [devices, setDevices] = useState<MicInputInfo[]>([])
  // Bumped when devices are plugged in / out: a chosen microphone that failed gets another try.
  const [deviceNonce, setDeviceNonce] = useState(0)

  const active = enabled && on
  const wantKey = prefs.devices.join('\n')

  useEffect(() => {
    const refresh = () => void listMics().then(setDevices)
    refresh()
    const onChange = () => {
      refresh()
      setDeviceNonce((n) => n + 1)
    }
    navigator.mediaDevices?.addEventListener?.('devicechange', onChange)
    return () => navigator.mediaDevices?.removeEventListener?.('devicechange', onChange)
  }, [])

  useEffect(() => {
    if (!active) {
      mixer.stop()
      setStatus('off')
      setErrors(new Map())
      return
    }
    let cancelled = false
    setStatus((s) => (s === 'on' ? s : 'starting'))
    const ids = wantKey.split('\n')
    void mixer.setDevices(ids).then((errs) => {
      if (cancelled) return
      setErrors(errs)
      setStatus(mixer.openIds.length ? 'on' : 'error')
      // Device names show up once access has been granted.
      void listMics().then(setDevices)
    })
    return () => {
      cancelled = true
    }
  }, [active, wantKey, deviceNonce, mixer])

  useEffect(() => () => mixer.stop(), [mixer])

  useEffect(() => mixer.setLevel(level), [mixer, level, status])
  useEffect(() => mixer.setReverb(reverb), [mixer, reverb, status])
  useEffect(() => mixer.setDeviceGains(prefs.gains), [mixer, prefs.gains, status])

  const toggleDevice = useCallback(
    (id: string) => {
      // 系统默认 and specific devices don't mix: the default is one of them, and would be heard twice.
      if (id === DEFAULT_MIC) {
        setPrefs({ devices: [DEFAULT_MIC] })
        return
      }
      const cur = prefs.devices.filter((d) => d !== DEFAULT_MIC)
      const next = cur.includes(id) ? cur.filter((d) => d !== id) : [...cur, id]
      setPrefs({ devices: next.length ? next : [DEFAULT_MIC] })
    },
    [prefs.devices, setPrefs],
  )
  const setGain = useCallback((id: string, g: number) => setPrefs({ gains: { ...prefs.gains, [id]: g } }), [prefs.gains, setPrefs])
  const setOn = useCallback((v: boolean) => void sendCommand({ action: 'set', micOn: v }), [])
  const levels = useCallback(() => mixer.levels(), [mixer])

  const live = status === 'on'
  const stream = useMemo(() => (live ? mixer.stream : null), [live, mixer])
  const tap = useMemo(() => (live ? mixer.tap : null), [live, mixer])

  return {
    on,
    setOn,
    status,
    errors,
    devices,
    selected: prefs.devices,
    toggleDevice,
    gains: prefs.gains,
    setGain,
    levels,
    stream,
    tap,
  }
}
