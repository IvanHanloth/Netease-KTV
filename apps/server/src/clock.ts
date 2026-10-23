/** Server clock for playback sync: epoch ms with sub-millisecond resolution, never jumps backwards. */
export function serverNow(): number {
  return performance.timeOrigin + performance.now()
}
