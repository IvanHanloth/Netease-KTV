/**
 * Songs and MVs whose files are being written right now (download, separation, pitch extraction,
 * key-shift render, MV download, alignment). Cache clearing and eviction leave them alone, even
 * when the song is no longer queued.
 */

const songs = new Map<number, number>()
const mvs = new Map<number, number>()

function track<T>(map: Map<number, number>, id: number, work: Promise<T>): Promise<T> {
  map.set(id, (map.get(id) ?? 0) + 1)
  const done = () => {
    const n = (map.get(id) ?? 1) - 1
    if (n <= 0) map.delete(id)
    else map.set(id, n)
  }
  work.then(done, done)
  return work
}

/** Mark `songId` busy until `work` settles. Returns `work`. */
export function busySong<T>(songId: number, work: Promise<T>): Promise<T> {
  return track(songs, songId, work)
}

export function busyMv<T>(mvId: number, work: Promise<T>): Promise<T> {
  return track(mvs, mvId, work)
}

export function busySongIds(): number[] {
  return [...songs.keys()]
}

export function busyMvIds(): number[] {
  return [...mvs.keys()]
}
