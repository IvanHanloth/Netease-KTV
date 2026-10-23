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
  }),
]) as z.ZodType<PlayerCommand>

const finite = z.number().refine(Number.isFinite)

/**
 * Messages from browsers over the WebSocket. Anything else is dropped: a malformed message must
 * never reach code that assumes its shape (an unknown role, `null`, a string position…).
 */
export const clientMessageSchema: z.ZodType<ClientMessage> = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), role: z.enum(CLIENT_ROLES) }),
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
]) as unknown as z.ZodType<ClientMessage>
