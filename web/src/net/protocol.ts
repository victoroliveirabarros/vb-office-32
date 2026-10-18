import { isInt, isNumber, isRecord, isString } from '../guards'

export type Dir = 'up' | 'down' | 'left' | 'right'

export type Player = { id: string; name: string; x: number; y: number; dir: Dir }
export type Pos = { id: string; x: number; y: number; dir: Dir }

export type MoveInput = { seq: number; dir: Dir }

export type ClientMessage =
  | { t: 'move'; d: MoveInput }
  | { t: 'ping'; d: { ts: number } }

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

export type ServerMessage =
  | { t: 'welcome'; d: Welcome }
  | { t: 'joined'; d: Player }
  | { t: 'left'; d: { id: string } }
  | { t: 'state'; d: State }
  | { t: 'pong'; d: { ts: number } }
  | { t: 'media'; d: Media }
  | { t: 'nearby'; d: Nearby }

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
      return isWelcome(d) ? { t: 'welcome', d } : null
    case 'joined':
      return isPlayer(d) ? { t: 'joined', d } : null
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

function isPlayer(v: unknown): v is Player {
  return isRecord(v) && isString(v.name) && isPos(v)
}

function isWelcome(d: Record<string, unknown>): d is Welcome {
  return (
    isString(d.selfId) &&
    isString(d.mapId) &&
    isNumber(d.tickRate) &&
    isNumber(d.stepMs) &&
    Array.isArray(d.players) &&
    d.players.every(isPlayer)
  )
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
