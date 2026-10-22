import type { Playability, PlaylistSummary, Song } from '../shared/types.js'

interface RawPrivilege {
  id?: number
  st?: number
  pl?: number
  fee?: number
}

export const isPaidFee = (f?: number) => f === 1 || f === 4

/**
 * Decide whether the logged-in account can play the full song from NetEase.
 *
 * Order matters: for an account without VIP, NetEase reports VIP songs with
 * `st < 0` too (same as songs with no copyright), so the song's own `fee`
 * must be checked before `st`. Otherwise VIP songs would be treated as
 * "no source" and could reach the unblock path.
 */
export function playabilityOf(fee: number, priv?: RawPrivilege | null): Playability {
  if (!priv) return isPaidFee(fee) ? 'vip' : 'ok'
  if ((priv.pl ?? 0) > 0 && (priv.st ?? 0) >= 0) return 'ok'
  if (isPaidFee(fee) || isPaidFee(priv.fee)) return 'vip'
  return 'no-source'
}

/** Map a NetEase song object (song_detail / cloudsearch / daily / playlist shapes). */
export function mapSong(raw: any, priv?: RawPrivilege | null): Song {
  const artists = (raw.ar ?? raw.artists ?? []).map((a: any) => ({ id: Number(a.id) || 0, name: String(a.name ?? '') }))
  const al = raw.al ?? raw.album ?? {}
  const fee = Number(raw.fee ?? 0)
  return {
    id: Number(raw.id),
    name: String(raw.name ?? ''),
    alias: (raw.alia ?? raw.alias ?? raw.tns ?? []).map(String),
    artists,
    album: { id: Number(al.id) || 0, name: String(al.name ?? ''), picUrl: String(al.picUrl ?? '') },
    duration: Number(raw.dt ?? raw.duration ?? 0),
    mvId: Number(raw.mv ?? raw.mvid ?? 0),
    fee,
    playable: playabilityOf(fee, priv ?? raw.privilege),
  }
}

/** Map a songs array with an optional parallel privileges array. */
export function mapSongs(songs: any[] = [], privileges: any[] = []): Song[] {
  const byId = new Map<number, RawPrivilege>()
  for (const p of privileges) if (p?.id) byId.set(Number(p.id), p)
  return songs.filter(Boolean).map((s) => mapSong(s, byId.get(Number(s.id)) ?? s.privilege))
}

export function mapPlaylist(raw: any): PlaylistSummary {
  return {
    id: Number(raw.id),
    name: String(raw.name ?? ''),
    coverUrl: String(raw.coverImgUrl ?? raw.picUrl ?? ''),
    trackCount: Number(raw.trackCount ?? 0),
    description: raw.updateFrequency ?? raw.description ?? undefined,
  }
}
