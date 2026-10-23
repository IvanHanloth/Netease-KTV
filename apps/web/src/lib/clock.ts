/**
 * Server-clock estimate for playback sync (TV reports, 耳返).
 *
 * NTP-style over the app WebSocket: ping at local time t0, the server stamps `t`, the pong arrives
 * at t1. The sample's offset is t − (t0 + t1) / 2, accurate to ± half the round trip, so only the
 * fastest round trips count: the estimate averages the 3 lowest-RTT samples of the last ~16.
 * Local time is performance.now() (monotonic, sub-millisecond).
 */

interface Sample {
  offset: number
  rtt: number
}

const WINDOW = 16
const samples: Sample[] = []
const sent = new Map<number, number>()
let nextId = 1
let offset: number | null = null
let rtt = Infinity
let timer: number | undefined
let send: ((id: number) => void) | null = null

function recompute() {
  const best = [...samples].sort((a, b) => a.rtt - b.rtt).slice(0, 3)
  if (!best.length) return
  offset = best.reduce((s, x) => s + x.offset, 0) / best.length
  rtt = best[0]!.rtt
}

function ping() {
  if (!send) return
  const id = nextId++
  sent.set(id, performance.now())
  // Forget pings that never came back.
  if (sent.size > 32) sent.delete(sent.keys().next().value as number)
  send(id)
}

/** Called by the socket on (re)connect: a quick burst, then one ping every few seconds. */
export function startClockSync(sendPing: (id: number) => void) {
  send = sendPing
  window.clearInterval(timer)
  let burst = 0
  const fast = window.setInterval(() => {
    ping()
    if (++burst >= 8) window.clearInterval(fast)
  }, 120)
  timer = window.setInterval(ping, 4000)
}

export function stopClockSync() {
  send = null
  window.clearInterval(timer)
}

export function handlePong(id: number, serverTime: number) {
  const t0 = sent.get(id)
  if (t0 === undefined) return
  sent.delete(id)
  const t1 = performance.now()
  samples.push({ offset: serverTime - (t0 + t1) / 2, rtt: t1 - t0 })
  if (samples.length > WINDOW) samples.shift()
  recompute()
}

/** Server time (ms) for a local performance.now() timestamp; null until the first pong. */
export function toServerTime(perf: number): number | null {
  return offset === null ? null : perf + offset
}

/** Local performance.now() timestamp for a server time (ms). */
export function toLocalTime(server: number): number | null {
  return offset === null ? null : server - offset
}

export function serverNow(): number | null {
  return toServerTime(performance.now())
}

/** Best round trip so far (ms): the estimate is good to about half of it. */
export function clockRtt(): number {
  return rtt
}

export function clockReady(): boolean {
  return offset !== null
}
