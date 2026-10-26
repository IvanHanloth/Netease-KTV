/**
 * 耳返 microphone return: the 主屏 streams its microphone mix to 耳返 phones over WebRTC, so a
 * singer hears their own voice (with the reverb) in the headphones. Signalling goes through the
 * server WebSocket (`rtc` messages); the audio itself goes straight across the LAN (host
 * candidates only, no STUN / TURN needed).
 *
 * The phone asks (`want`); the TV makes an offer with its microphone track, or answers
 * `unavailable` while its microphone is off. The phone keeps asking every few seconds until it
 * gets one, and starts over on `reset` (another 大屏 became the 主屏) or when the link drops.
 */
import type { RtcSignal } from '@shared/types'
import { onRtc, sendMessage } from '../store/app'

const PC_CONFIG: RTCConfiguration = { iceServers: [], bundlePolicy: 'max-bundle' }

const send = (to: number, signal: RtcSignal) => sendMessage({ type: 'rtc', to, signal })

const iceOf = (c: RTCIceCandidate | null): RtcSignal['candidate'] =>
  c ? { candidate: c.candidate, sdpMid: c.sdpMid, sdpMLineIndex: c.sdpMLineIndex, usernameFragment: c.usernameFragment } : null

/**
 * Opus for a monitor: stereo (the reverb is stereo), a high bitrate, no DTX (silence suppression
 * makes the reverb tail pump), and 10 ms packets instead of 20 for a little less delay.
 */
function tuneOpus(sdp: string): string {
  const m = /a=rtpmap:(\d+) opus\/48000/i.exec(sdp)
  if (!m) return sdp
  const pt = m[1]
  const fmtp = new RegExp(`a=fmtp:${pt} ([^\\r\\n]*)`)
  const extra: Record<string, string> = { stereo: '1', 'sprop-stereo': '1', maxaveragebitrate: '160000', usedtx: '0', minptime: '10' }
  const merge = (params: string) => {
    const kv = new Map(params.split(';').filter(Boolean).map((p) => p.trim().split('=') as [string, string]))
    for (const [k, v] of Object.entries(extra)) kv.set(k, v)
    return [...kv].map(([k, v]) => `${k}=${v}`).join(';')
  }
  let out = fmtp.test(sdp) ? sdp.replace(fmtp, (_, p: string) => `a=fmtp:${pt} ${merge(p)}`) : sdp.replace(m[0], `${m[0]}\r\na=fmtp:${pt} ${merge('')}`)
  if (!/a=ptime:/.test(out)) out = out.replace(/(m=audio[^\r\n]*\r\n)/, '$1a=ptime:10\r\n')
  return out
}

/** Queue ICE candidates that arrive before the remote description is set. */
class Peer {
  readonly pc = new RTCPeerConnection(PC_CONFIG)
  private early: RTCIceCandidateInit[] = []
  private described = false
  constructor(readonly remote: number) {
    this.pc.onicecandidate = (e) => send(remote, { kind: 'ice', candidate: iceOf(e.candidate) })
  }
  async describe(desc: RTCSessionDescriptionInit) {
    await this.pc.setRemoteDescription(desc)
    this.described = true
    for (const c of this.early.splice(0)) await this.pc.addIceCandidate(c).catch(() => {})
  }
  async ice(c: RTCIceCandidateInit | null | undefined) {
    if (!c) return
    if (!this.described) this.early.push(c)
    else await this.pc.addIceCandidate(c).catch(() => {})
  }
  close() {
    this.pc.onicecandidate = null
    this.pc.ontrack = null
    this.pc.onconnectionstatechange = null
    this.pc.close()
  }
}

// ---------------- 主屏 side ----------------

/** Serves the microphone stream to every 耳返 that asks for it. */
export class MicReturnHost {
  private peers = new Map<number, Peer>()
  private stream: MediaStream | null = null
  private off: (() => void) | null = null

  start() {
    if (this.off || typeof RTCPeerConnection === 'undefined') return
    this.off = onRtc((from, s) => void this.onSignal(from, s))
  }

  /** The microphone mix to send; null closes every connection (the microphone went off). */
  setStream(stream: MediaStream | null) {
    if (stream === this.stream) return
    this.stream = stream
    const track = stream?.getAudioTracks()[0] ?? null
    for (const [id, p] of this.peers) {
      const sender = p.pc.getSenders()[0]
      if (track && sender) void sender.replaceTrack(track).catch(() => this.drop(id, true))
      else this.drop(id, true)
    }
  }

  get count() {
    return this.peers.size
  }

  private drop(id: number, tell: boolean) {
    const p = this.peers.get(id)
    if (!p) return
    this.peers.delete(id)
    p.close()
    if (tell) send(id, { kind: 'bye' })
  }

  private async onSignal(from: number, s: RtcSignal) {
    switch (s.kind) {
      case 'want': {
        this.drop(from, false)
        const track = this.stream?.getAudioTracks()[0]
        if (!this.stream || !track) {
          send(from, { kind: 'unavailable' })
          return
        }
        const p = new Peer(from)
        this.peers.set(from, p)
        p.pc.onconnectionstatechange = () => {
          if (p.pc.connectionState === 'failed' || p.pc.connectionState === 'closed') {
            if (this.peers.get(from) === p) this.drop(from, false)
          }
        }
        const sender = p.pc.addTrack(track, this.stream)
        try {
          const params = sender.getParameters()
          if (params.encodings?.length) {
            params.encodings[0]!.maxBitrate = 160_000
            params.encodings[0]!.priority = 'high'
            params.encodings[0]!.networkPriority = 'high'
            await sender.setParameters(params)
          }
        } catch {
          /* optional */
        }
        try {
          const offer = await p.pc.createOffer()
          await p.pc.setLocalDescription({ type: 'offer', sdp: tuneOpus(offer.sdp ?? '') })
          if (this.peers.get(from) !== p) return
          send(from, { kind: 'offer', sdp: p.pc.localDescription?.sdp ?? '' })
        } catch {
          this.drop(from, true)
        }
        return
      }
      case 'answer': {
        const p = this.peers.get(from)
        if (p && s.sdp) await p.describe({ type: 'answer', sdp: s.sdp }).catch(() => this.drop(from, true))
        return
      }
      case 'ice':
        await this.peers.get(from)?.ice(s.candidate ?? null)
        return
      case 'bye':
        this.drop(from, false)
        return
    }
  }

  stop() {
    this.off?.()
    this.off = null
    for (const id of [...this.peers.keys()]) this.drop(id, true)
    this.stream = null
  }
}

// ---------------- 耳返 side ----------------

export type MicReturnState = 'off' | 'connecting' | 'live' | 'unavailable' | 'unsupported'

/** Asks the 主屏 for its microphone and hands the incoming stream to `onStream`. */
export class MicReturnClient {
  state: MicReturnState = 'off'
  onState: ((s: MicReturnState) => void) | null = null
  onStream: ((s: MediaStream | null) => void) | null = null
  private peer: Peer | null = null
  private off: (() => void) | null = null
  private retry: number | undefined
  private lostTimer: number | undefined

  private set(s: MicReturnState) {
    if (s === this.state) return
    this.state = s
    this.onState?.(s)
  }

  start() {
    if (this.off) return
    if (typeof RTCPeerConnection === 'undefined') {
      this.set('unsupported')
      return
    }
    this.off = onRtc((from, s) => void this.onSignal(from, s))
    this.set('connecting')
    this.ask()
  }

  /** Ask the 主屏 (again), and keep asking until a connection is up. */
  private ask(delay = 0) {
    window.clearTimeout(this.retry)
    this.retry = window.setTimeout(() => {
      if (!this.off) return
      if (this.state !== 'live') sendMessage({ type: 'rtc', signal: { kind: 'want' } })
      this.ask(5000)
    }, delay)
  }

  private closePeer() {
    window.clearTimeout(this.lostTimer)
    if (!this.peer) return
    this.peer.close()
    this.peer = null
    this.onStream?.(null)
  }

  private async onSignal(from: number, s: RtcSignal) {
    switch (s.kind) {
      case 'offer': {
        if (!s.sdp) return
        this.closePeer()
        const p = new Peer(from)
        this.peer = p
        p.pc.ontrack = (e) => {
          // The lowest playout delay the browser allows: this is a live monitor.
          const r = e.receiver as unknown as Record<string, unknown>
          try {
            if ('jitterBufferTarget' in r) r.jitterBufferTarget = 0
            else r.playoutDelayHint = 0
          } catch {
            /* not supported */
          }
          this.onStream?.(e.streams[0] ?? new MediaStream([e.track]))
        }
        p.pc.onconnectionstatechange = () => {
          if (this.peer !== p) return
          const st = p.pc.connectionState
          window.clearTimeout(this.lostTimer)
          if (st === 'connected') this.set('live')
          else if (st === 'failed' || st === 'closed') this.lost()
          // 'disconnected' often recovers by itself; give it a moment.
          else if (st === 'disconnected') this.lostTimer = window.setTimeout(() => this.lost(), 3000)
        }
        try {
          await p.describe({ type: 'offer', sdp: s.sdp })
          const answer = await p.pc.createAnswer()
          await p.pc.setLocalDescription({ type: 'answer', sdp: tuneOpus(answer.sdp ?? '') })
          if (this.peer !== p) return
          send(from, { kind: 'answer', sdp: p.pc.localDescription?.sdp ?? '' })
        } catch {
          if (this.peer === p) this.lost()
        }
        return
      }
      case 'ice':
        if (this.peer?.remote === from) await this.peer.ice(s.candidate ?? null)
        return
      case 'unavailable':
        if (this.state !== 'live') this.set('unavailable')
        return
      case 'bye':
        if (this.peer && this.peer.remote !== from) return
        this.closePeer()
        this.set('unavailable')
        this.ask(1500)
        return
      case 'reset':
        this.closePeer()
        this.set('connecting')
        this.ask(300)
        return
    }
  }

  private lost() {
    this.closePeer()
    this.set('connecting')
    this.ask(1000)
  }

  stop() {
    window.clearTimeout(this.retry)
    const p = this.peer
    if (p) send(p.remote, { kind: 'bye' })
    this.closePeer()
    this.off?.()
    this.off = null
    this.set('off')
  }
}
