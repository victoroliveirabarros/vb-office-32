import { fromWire } from '../avatar/appearance'
import type { Appearance } from '../avatar/appearance'
import { isInt, isNumber, isRecord, isString } from '../guards'

export type Dir = 'up' | 'down' | 'left' | 'right'

/** appearance is absent only from an older server; the client shows the first look. */
export type Player = { id: string; name: string; x: number; y: number; dir: Dir; appearance?: Appearance }
export type Pos = { id: string; x: number; y: number; dir: Dir }

export type MoveInput = { seq: number; dir: Dir }

export type ChatScope = 'everyone' | 'nearby' | 'direct'

export type ChatErrorReason = 'rate_limited' | 'too_long' | 'empty' | 'offline' | 'invalid'

/** cid correlates the server's echo or chatError with the send. */
export type ChatSend = { cid: string; scope: ChatScope; to?: string; text: string }

export type ClientMessage =
  | { t: 'move'; d: MoveInput }
  | { t: 'ping'; d: { ts: number } }
  | { t: 'chat'; d: ChatSend }
  | { t: 'appearance'; d: Appearance }

export type Welcome = {
  selfId: string
  mapId: string
  tickRate: number
  stepMs: number
  players: Player[]
}

export type State = { tick: number; ack: number; players: Pos[] }

/** LiveKit connection; expiresAt is unix milliseconds. */
export type Media = { url: string; token: string; expiresAt: number }

/** Full set of players in earshot of the recipient, sorted, without itself. */
export type Nearby = { ids: string[] }

export type ZoneKind = 'meeting' | 'private'

/** The recipient's own zone; id "" means outside every zone. */
export type Zone = { id: string; name?: string; kind?: ZoneKind }

/** at is unix milliseconds; to only on direct; cid only on the sender's echo. */
export type Chat = {
  id: string
  at: number
  from: string
  fromName: string
  scope: ChatScope
  to?: string
  text: string
  cid?: string
}

export type ChatError = { cid: string; reason: ChatErrorReason }

export type AppearanceChange = { id: string; appearance: Appearance }

export type ServerMessage =
  | { t: 'welcome'; d: Welcome }
  | { t: 'joined'; d: Player }
  | { t: 'left'; d: { id: string } }
  | { t: 'state'; d: State }
  | { t: 'pong'; d: { ts: number } }
  | { t: 'media'; d: Media }
  | { t: 'nearby'; d: Nearby }
  | { t: 'zone'; d: Zone }
  | { t: 'chat'; d: Chat }
  | { t: 'chatHistory'; d: { messages: Chat[] } }
  | { t: 'chatError'; d: ChatError }
  | { t: 'appearance'; d: AppearanceChange }

export const CLOSE_REPLACED = 4001
export const CLOSE_EXPIRED = 4002
export const MAX_PENDING_INPUTS = 8

const NAME_PATTERN = /^[A-Za-z0-9 _-]{1,24}$/

export function normalizeName(raw: string): string | null {
  const name = raw.trim()
  return NAME_PATTERN.test(name) ? name : null
}

export function encode(msg: ClientMessage): string {
  return JSON.stringify(msg)
}

export function parseServerMessage(raw: string): ServerMessage | null {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecord(value) || typeof value.t !== 'string' || !isRecord(value.d)) return null
  const d = value.d

  switch (value.t) {
    case 'welcome':
      return toWelcome(d)
    case 'joined': {
      const player = toPlayer(d)
      return player ? { t: 'joined', d: player } : null
    }
    case 'left':
      return isString(d.id) ? { t: 'left', d: { id: d.id } } : null
    case 'state':
      return isState(d) ? { t: 'state', d } : null
    case 'pong':
      return isNumber(d.ts) ? { t: 'pong', d: { ts: d.ts } } : null
    case 'media':
      return isMedia(d) ? { t: 'media', d: { url: d.url, token: d.token, expiresAt: d.expiresAt } } : null
    case 'nearby':
      return isNearby(d) ? { t: 'nearby', d: { ids: d.ids } } : null
    case 'zone': {
      const zone = toZone(d)
      return zone ? { t: 'zone', d: zone } : null
    }
    case 'chat': {
      const chat = toChat(d)
      return chat ? { t: 'chat', d: chat } : null
    }
    case 'chatHistory':
      return Array.isArray(d.messages) ? { t: 'chatHistory', d: { messages: d.messages.flatMap((m) => toChat(m) ?? []) } } : null
    case 'chatError':
      return isString(d.cid) && isString(d.reason) ? { t: 'chatError', d: { cid: d.cid, reason: errorReason(d.reason) } } : null
    case 'appearance': {
      const appearance = fromWire(d.appearance)
      return isString(d.id) && appearance ? { t: 'appearance', d: { id: d.id, appearance } } : null
    }
    default:
      return null
  }
}

export function isDir(v: unknown): v is Dir {
  return v === 'up' || v === 'down' || v === 'left' || v === 'right'
}

function isPos(v: unknown): v is Pos {
  return isRecord(v) && isString(v.id) && isInt(v.x) && isInt(v.y) && isDir(v.dir)
}

// A malformed appearance costs only the look, not the player.
function toPlayer(v: unknown): Player | null {
  if (!isRecord(v) || !isPos(v)) return null
  const { name, appearance: look } = v as Record<string, unknown>
  if (!isString(name)) return null
  const player: Player = { id: v.id, name, x: v.x, y: v.y, dir: v.dir }
  const appearance = look == null ? null : fromWire(look)
  if (appearance) player.appearance = appearance
  return player
}

function toWelcome(d: Record<string, unknown>): ServerMessage | null {
  if (!isString(d.selfId) || !isString(d.mapId) || !isNumber(d.tickRate) || !isNumber(d.stepMs) || !Array.isArray(d.players)) {
    return null
  }
  const players: Player[] = []
  for (const p of d.players) {
    const player = toPlayer(p)
    if (!player) return null
    players.push(player)
  }
  return { t: 'welcome', d: { selfId: d.selfId, mapId: d.mapId, tickRate: d.tickRate, stepMs: d.stepMs, players } }
}

function isState(d: Record<string, unknown>): d is State {
  return isInt(d.tick) && isInt(d.ack) && Array.isArray(d.players) && d.players.every(isPos)
}

function isMedia(d: Record<string, unknown>): d is Media {
  return isString(d.url) && d.url !== '' && isString(d.token) && d.token !== '' && isInt(d.expiresAt)
}

function isNearby(d: Record<string, unknown>): d is Nearby {
  return Array.isArray(d.ids) && d.ids.every(isString)
}

// A kind unknown to this client is treated as the most restrictive one.
function toZone(d: Record<string, unknown>): Zone | null {
  if (!isString(d.id)) return null
  if (d.id === '') return { id: '' }
  if (d.name != null && !isString(d.name)) return null
  const zone: Zone = { id: d.id, kind: d.kind === 'meeting' ? 'meeting' : 'private' }
  if (isString(d.name)) zone.name = d.name
  return zone
}

export function isChatScope(v: unknown): v is ChatScope {
  return v === 'everyone' || v === 'nearby' || v === 'direct'
}

const CHAT_ERROR_REASONS: readonly string[] = ['rate_limited', 'too_long', 'empty', 'offline', 'invalid']

// An unknown reason from a newer server still fails the send.
function errorReason(v: string): ChatErrorReason {
  return CHAT_ERROR_REASONS.includes(v) ? (v as ChatErrorReason) : 'invalid'
}

function toChat(v: unknown): Chat | null {
  if (!isRecord(v)) return null
  const { id, at, from, fromName, scope, to, text, cid } = v
  if (!isString(id) || id === '' || !isInt(at) || !isString(from) || !isString(fromName) || !isChatScope(scope) || !isString(text)) {
    return null
  }
  if (scope === 'direct' ? !isString(to) : to != null) return null
  if (cid != null && !isString(cid)) return null
  const chat: Chat = { id, at, from, fromName, scope, text }
  if (scope === 'direct' && isString(to)) chat.to = to
  if (isString(cid)) chat.cid = cid
  return chat
}
