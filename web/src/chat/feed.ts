import type { ZoneMap } from '../game/zones'
import type { ServerMessage } from '../net/protocol'
import { Roster } from './roster'

export type RosterFeed = {
  readonly roster: Roster
  /** Called after every change, already applied. */
  onChange(fn: () => void): () => void
  setZones(zones: ZoneMap): void
}

/**
 * One roster for the chat and the side panels, fed by the game socket. It
 * must subscribe before them, so they read it already updated.
 */
export function rosterFeed(link: { onMessage(fn: (msg: ServerMessage) => void): unknown }): RosterFeed {
  const roster = new Roster()
  const listeners = new Set<() => void>()
  const emit = () => listeners.forEach((fn) => fn())
  link.onMessage((msg) => {
    if (roster.handle(msg)) emit()
  })
  return {
    roster,
    onChange(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    setZones(zones) {
      if (roster.setZones(zones)) emit()
    },
  }
}
