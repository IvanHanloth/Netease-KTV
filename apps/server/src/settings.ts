import { config } from './config.js'
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
    publicUrl: saved.publicUrl ?? config.defaults.publicUrl,
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
  kv.set(KEY, next)
  return next
}
