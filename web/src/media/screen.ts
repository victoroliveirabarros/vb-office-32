import type { Zone } from '../net/protocol'
import type { Publication } from './subscriptions'

// Screens are shared only in meeting rooms; zone is null outside every zone.
export function inMeeting(zone: Zone | null): boolean {
  return zone?.kind === 'meeting'
}

// sharers are the nearby participants publishing a screen. Inside a zone,
// nearby is everyone in the same room.
export function sharers(pubs: readonly Publication[], nearby: ReadonlySet<string>): Set<string> {
  const ids = new Set<string>()
  for (const pub of pubs) if (pub.source === 'screen' && nearby.has(pub.identity)) ids.add(pub.identity)
  return ids
}

// canShare tells whether a new share may start: in a meeting room, with the
// call up and nobody else in the room already sharing.
export function canShare(zone: Zone | null, connected: boolean, othersSharing: boolean): boolean {
  return inMeeting(zone) && connected && !othersSharing
}

// shouldStop tells whether an ongoing share must end in this zone.
export function shouldStop(zone: Zone | null): boolean {
  return !inMeeting(zone)
}

// permissionsOnlyShrink tells whether subscriber permissions may only lose
// identities: outside a meeting room while our screen may still be on air,
// live or with its picker or publish pending. Widening waits for it to stop.
export function permissionsOnlyShrink(zone: Zone | null, live: boolean, busy: boolean): boolean {
  return (live || busy) && !inMeeting(zone)
}

// yieldsScreen tells whether our share must give way: two shares started at
// once in the same room, and the smallest identity keeps it.
export function yieldsScreen(pubs: readonly Publication[], nearby: ReadonlySet<string>, self: string): boolean {
  return [...sharers(pubs, nearby)].some((id) => id < self)
}

// screenTarget is the one screen to watch: none outside a meeting room, the
// current one while it is still shared, otherwise the smallest identity.
export function screenTarget(
  pubs: readonly Publication[],
  nearby: ReadonlySet<string>,
  zone: Zone | null,
  current: string | null,
): string | null {
  if (!inMeeting(zone)) return null
  const ids = sharers(pubs, nearby)
  if (current !== null && ids.has(current)) return current
  return [...ids].sort()[0] ?? null
}
