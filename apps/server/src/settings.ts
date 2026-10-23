import { config } from './config.js'
import { hub } from './core/hub.js'
import { kv } from './db.js'
import type { Settings, SoundLevel } from './shared/types.js'

const KEY = 'settings'
const LEVELS: SoundLevel[] = ['standard', 'higher', 'exhigh', 'lossless', 'hires']

export function getSettings(): Settings {
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
    idleEnabled: saved.idleEnabled ?? config.defaults.idleEnabled,
    idleVolume: saved.idleVolume ?? config.defaults.idleVolume,
    idleSongs: saved.idleSongs ?? config.defaults.idleSongs,
  }
}

export function updateSettings(patch: Partial<Settings>, allowedSources: string[]): Settings {
  const next = { ...getSettings() }
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
    next.cacheLimitGB = Math.round(Math.min(500, Math.max(1, patch.cacheLimitGB)))
  }
  if (typeof patch.scoreTolerance === 'number' && Number.isFinite(patch.scoreTolerance)) {
    next.scoreTolerance = Math.round(Math.min(3, Math.max(0.3, patch.scoreTolerance)) * 10) / 10
  }
  if (typeof patch.idleEnabled === 'boolean') next.idleEnabled = patch.idleEnabled
  if (typeof patch.idleVolume === 'number' && Number.isFinite(patch.idleVolume)) {
    next.idleVolume = Math.round(Math.min(1, Math.max(0, patch.idleVolume)) * 100) / 100
  }
  if (Array.isArray(patch.idleSongs)) {
    next.idleSongs = [...new Set(patch.idleSongs.filter((id) => Number.isInteger(id) && id > 0))].slice(0, 100)
  }
  kv.set(KEY, next)
  hub.broadcast({ type: 'settings' })
  return next
}
