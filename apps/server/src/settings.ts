import { config } from './config.js'
import { hub } from './core/hub.js'
import { kv } from './db.js'
import { SETTING_LIMITS, SOUND_LEVELS } from './shared/constants.js'
import type { Settings, SoundLevel } from './shared/types.js'

const KEY = 'settings'
const LEVELS: readonly SoundLevel[] = SOUND_LEVELS
const clampTo = (n: number, r: { min: number; max: number }) => Math.min(r.max, Math.max(r.min, n))

/** Parsed settings, kept until the next update (read on hot paths: pipeline loops, every MV lookup). */
let current: Settings | null = null

export function getSettings(): Settings {
  current ??= load()
  return current
}

function load(): Settings {
  const saved = kv.get<Partial<Settings>>(KEY) ?? {}
  return {
    unblockEnabled: saved.unblockEnabled ?? config.defaults.unblockEnabled,
    unblockSources: saved.unblockSources ?? config.defaults.unblockSources,
    audioLevel: saved.audioLevel ?? config.defaults.audioLevel,
    separatorModel: saved.separatorModel ?? config.defaults.separatorModel,
    // Empty means "not set in the UI": fall back to PUBLIC_URL (filled in by the start scripts).
    publicUrl: saved.publicUrl || config.defaults.publicUrl,
    scoringEnabled: saved.scoringEnabled ?? config.defaults.scoringEnabled,
    scoreTolerance: saved.scoreTolerance ?? config.defaults.scoreTolerance,
    mvPreload: saved.mvPreload ?? config.defaults.mvPreload,
    mvResolution: saved.mvResolution ?? config.defaults.mvResolution,
    cacheLimitGB: saved.cacheLimitGB ?? config.defaults.cacheLimitGB,
    multiScreenSync: saved.multiScreenSync ?? config.defaults.multiScreenSync,
    multiScreenAudio: saved.multiScreenAudio ?? config.defaults.multiScreenAudio,
    idleEnabled: saved.idleEnabled ?? config.defaults.idleEnabled,
    idleSongs: saved.idleSongs ?? config.defaults.idleSongs,
  }
}

export function updateSettings(patch: Partial<Settings>, allowedSources: string[]): Settings {
  const next = { ...getSettings(), idleSongs: [...getSettings().idleSongs], unblockSources: [...getSettings().unblockSources] }
  if (typeof patch.unblockEnabled === 'boolean') next.unblockEnabled = patch.unblockEnabled
  if (Array.isArray(patch.unblockSources)) {
    next.unblockSources = patch.unblockSources.filter((s) => allowedSources.includes(s))
  }
  if (patch.audioLevel && LEVELS.includes(patch.audioLevel)) next.audioLevel = patch.audioLevel
  if (typeof patch.separatorModel === 'string') next.separatorModel = patch.separatorModel.trim()
  if (typeof patch.publicUrl === 'string') next.publicUrl = patch.publicUrl.trim().replace(/\/$/, '')
  if (typeof patch.scoringEnabled === 'boolean') next.scoringEnabled = patch.scoringEnabled
  if (typeof patch.mvPreload === 'boolean') next.mvPreload = patch.mvPreload
  if (patch.mvResolution === 480 || patch.mvResolution === 720 || patch.mvResolution === 1080) {
    next.mvResolution = patch.mvResolution
  }
  if (typeof patch.cacheLimitGB === 'number' && Number.isFinite(patch.cacheLimitGB)) {
    next.cacheLimitGB = Math.round(clampTo(patch.cacheLimitGB, SETTING_LIMITS.cacheLimitGB))
  }
  if (typeof patch.scoreTolerance === 'number' && Number.isFinite(patch.scoreTolerance)) {
    next.scoreTolerance = Math.round(clampTo(patch.scoreTolerance, SETTING_LIMITS.scoreTolerance) * 10) / 10
  }
  if (typeof patch.multiScreenSync === 'boolean') next.multiScreenSync = patch.multiScreenSync
  if (typeof patch.multiScreenAudio === 'boolean') next.multiScreenAudio = patch.multiScreenAudio
  if (typeof patch.idleEnabled === 'boolean') next.idleEnabled = patch.idleEnabled
  if (Array.isArray(patch.idleSongs)) {
    next.idleSongs = [...new Set(patch.idleSongs.filter((id) => Number.isInteger(id) && id > 0))].slice(0, SETTING_LIMITS.idleSongs.max)
  }
  kv.set(KEY, next)
  current = null
  hub.broadcast({ type: 'settings' })
  return getSettings()
}
