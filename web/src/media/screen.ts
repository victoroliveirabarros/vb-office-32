import type { Zone } from '../net/protocol'
import type { Publication } from './subscriptions'

// Screens are shared inside any zone; zone is null outside every zone.
export function inZone(zone: Zone | null): boolean {
  return zone !== null && zone.id !== ''
}

// sharers are the nearby participants publishing a screen. Inside a zone,
// nearby is everyone in the same zone.
export function sharers(pubs: readonly Publication[], nearby: ReadonlySet<string>): Set<string> {
  const ids = new Set<string>()
  for (const pub of pubs) if (pub.source === 'screen' && nearby.has(pub.identity)) ids.add(pub.identity)
  return ids
}

// canShare tells whether a new share may start: inside a zone, with the
// call up and nobody else in the zone already sharing.
export function canShare(zone: Zone | null, connected: boolean, othersSharing: boolean): boolean {
  return inZone(zone) && connected && !othersSharing
}

// shouldStop tells whether a share started in the zone sharing must end in
// zone: outside every zone or in another one, since zones may touch.
export function shouldStop(sharing: string | null, zone: Zone | null): boolean {
  return !inZone(zone) || zone?.id !== sharing
}

// permissionsOnlyShrink tells whether subscriber permissions may only lose
// identities: away from the zone of our screen while it may still be on
// air, live or with its picker or publish pending. Widening waits for it to
// stop.
export function permissionsOnlyShrink(zone: Zone | null, screenZone: string | null, live: boolean, busy: boolean): boolean {
  return (live || busy) && zone?.id !== screenZone
}

// yieldsScreen tells whether our share must give way: two shares started at
// once in the same zone, and the smallest identity keeps it.
export function yieldsScreen(pubs: readonly Publication[], nearby: ReadonlySet<string>, self: string): boolean {
  return [...sharers(pubs, nearby)].some((id) => id < self)
}

// screenTarget is the one screen to watch: none outside a zone, the current
// one while it is still shared, otherwise the smallest identity.
export function screenTarget(
  pubs: readonly Publication[],
  nearby: ReadonlySet<string>,
  zone: Zone | null,
  current: string | null,
): string | null {
  if (!inZone(zone)) return null
  const ids = sharers(pubs, nearby)
  if (current !== null && ids.has(current)) return current
  return [...ids].sort()[0] ?? null
}
