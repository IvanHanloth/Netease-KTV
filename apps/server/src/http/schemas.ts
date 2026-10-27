import { z } from 'zod'
import { CLIENT_ROLES, DISPLAY_MODES, KEY_MAX, KEY_MIN, TRACK_MODES } from '../shared/constants.js'
import type { ClientMessage, PlayerCommand } from '../shared/types.js'

/** Validation shared by the HTTP routes and the WebSocket. */

export const keySchema = z.number().int().min(KEY_MIN).max(KEY_MAX)

export const commandSchema: z.ZodType<PlayerCommand> = z.union([
  z.object({ action: z.enum(['play', 'pause', 'toggle', 'next', 'restart']) }),
  z.object({ action: z.literal('seek'), position: z.number().min(0) }),
  z.object({
    action: z.literal('set'),
    musicVolume: z.number().min(0).max(1).optional(),
    vocalVolume: z.number().min(0).max(1).optional(),
    key: keySchema.optional(),
    trackMode: z.enum(TRACK_MODES).optional(),
    displayMode: z.enum(DISPLAY_MODES).optional(),
    leadVocal: z.boolean().optional(),
    idleVolume: z.number().min(0).max(1).optional(),
    micVolume: z.number().min(0).max(1).optional(),
    reverb: z.number().min(0).max(1).optional(),
    micOn: z.boolean().optional(),
    scoreOn: z.boolean().optional(),
  }),
]) as z.ZodType<PlayerCommand>

const finite = z.number().refine(Number.isFinite)

const micError = z.enum(['insecure', 'denied', 'unavailable'])
const screenReportSchema = z.object({
  unlocked: z.boolean(),
  displayMode: z.enum(DISPLAY_MODES),
  muted: z.boolean(),
  volume: z.number().min(0).max(1),
  mic: z
    .object({
      status: z.enum(['off', 'starting', 'on', 'error']),
      devices: z.array(z.object({ id: z.string().max(256), label: z.string().max(200) })).max(32),
      selected: z.array(z.string().max(256)).max(32),
      errors: z.record(z.string().max(256), micError),
    })
    .nullable(),
  scoreIssue: z.string().max(120).nullable().optional(),
})
const screenCommandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('claim') }),
  z.object({ action: z.literal('identify') }),
  z.object({
    action: z.literal('set'),
    displayMode: z.enum(DISPLAY_MODES).optional(),
    muted: z.boolean().optional(),
    volume: z.number().min(0).max(1).optional(),
  }),
  z.object({ action: z.literal('micDevice'), deviceId: z.string().max(256) }),
])

const rtcSignalSchema = z.object({
  kind: z.enum(['want', 'offer', 'answer', 'ice', 'bye', 'unavailable', 'reset']),
  sdp: z.string().max(64_000).optional(),
  candidate: z
    .object({
      candidate: z.string().max(2_000),
      sdpMid: z.string().max(64).nullable().optional(),
      sdpMLineIndex: z.number().int().min(0).max(64).nullable().optional(),
      usernameFragment: z.string().max(256).nullable().optional(),
    })
    .nullable()
    .optional(),
})

/**
 * Messages from browsers over the WebSocket. Anything else is dropped: a malformed message must
 * never reach code that assumes its shape (an unknown role, `null`, a string position…).
 */
export const clientMessageSchema: z.ZodType<ClientMessage> = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), role: z.enum(CLIENT_ROLES), screenKey: z.string().min(1).max(64).optional() }),
  z.object({ type: z.literal('ping'), id: finite }),
  z.object({ type: z.literal('claim'), displayMode: z.enum(DISPLAY_MODES).optional() }),
  // The command itself is checked with commandSchema where it is used.
  z.object({ type: z.literal('command'), command: z.unknown() }),
  z.object({
    type: z.literal('report'),
    position: finite,
    playing: z.boolean(),
    at: finite.optional(),
    uid: z.string().max(100).optional(),
    epoch: z.number().int().optional(),
    starting: z.boolean().optional(),
  }),
  z.object({ type: z.literal('ended') }),
  z.object({
    type: z.literal('idleReport'),
    songId: z.number().int().positive().nullable(),
    position: finite,
    playing: z.boolean(),
    at: finite.optional(),
  }),
  z.object({ type: z.literal('rtc'), to: z.number().int().positive().optional(), signal: rtcSignalSchema }),
  z.object({ type: z.literal('screen'), state: screenReportSchema }),
  z.object({ type: z.literal('screenCommand'), to: z.number().int().positive(), command: screenCommandSchema }),
]) as unknown as z.ZodType<ClientMessage>
