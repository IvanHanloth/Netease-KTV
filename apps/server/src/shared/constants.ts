import type { DataCacheKind, MediaCacheKind } from './types.js'

/** Runtime values shared by server and web (types.ts holds only types). */

export const MEDIA_CACHE_KINDS: readonly MediaCacheKind[] = ['original', 'stems', 'pitched', 'analysis', 'mv', 'temp']
export const DATA_CACHE_KINDS: readonly DataCacheKind[] = ['search', 'library', 'recommend', 'lyrics', 'songs']
