import type { Desk, DeskGuest, ServerMessage } from '../net/protocol'
import type { Gate } from './grid'
import type { ZoneMap } from './zones'

/** A desk with an owner lets in only the owner and the owner's guests. */
export function lockedForMe(desk: Desk, self: string | null, invites: ReadonlySet<string>): boolean {
  return desk.locked && desk.ownerId !== self && !invites.has(desk.id)
}

/**
 * "Mesa de Ana Souza", or the zone's name for a desk without an owner. The
 * server names an owner it knows nothing about after the zone.
 */
export function deskLabel(zone: { name: string }, desk: Desk | null): string {
  const owner = desk?.ownerName
  return owner && owner !== zone.name ? `Mesa de ${owner}` : zone.name
}

/** The server's rule: a step into another zone that is locked for us is refused. */
export function deskGate(zones: ZoneMap, locked: (zone: string) => boolean): Gate {
  return (from, to) => {
    const zone = zones.zoneAt(to.x, to.y)
    return zone === null || zone.id === zones.zoneAt(from.x, from.y)?.id || !locked(zone.id)
  }
}

// Desks keeps what the server says about the desks: their public state, the
// guests of ours and the desks we are invited to.
export class Desks {
  private selfId: string | null = null
  private list: Desk[] = []
  private ownGuests: DeskGuest[] = []
  private readonly invites = new Set<string>()

  get self(): string | null {
    return this.selfId
  }

  /** Applies msg and reports whether anything changed. */
  handle(msg: ServerMessage): boolean {
    switch (msg.t) {
      case 'welcome':
        // The server sends the desks, our guests and our invites right after.
        this.selfId = msg.d.selfId
        this.ownGuests = []
        this.invites.clear()
        return true
      case 'desks':
        this.list = msg.d.desks
        return true
      case 'deskGuests':
        this.ownGuests = msg.d.guests
        return true
      case 'deskInvite':
        if (msg.d.invited === this.invites.has(msg.d.desk)) return false
        if (msg.d.invited) this.invites.add(msg.d.desk)
        else this.invites.delete(msg.d.desk)
        return true
      default:
        return false
    }
  }

  all(): readonly Desk[] {
    return this.list
  }

  get(id: string): Desk | null {
    return this.list.find((d) => d.id === id) ?? null
  }

  /** The desk we own, if any. */
  mine(): Desk | null {
    return this.selfId === null ? null : (this.list.find((d) => d.ownerId === this.selfId) ?? null)
  }

  /** Who is invited to our desk, by id. */
  guests(): readonly DeskGuest[] {
    return this.mine() ? this.ownGuests : []
  }

  invited(id: string): boolean {
    return this.guests().some((g) => g.id === id)
  }

  lockedForMe(id: string): boolean {
    const desk = this.get(id)
    return desk !== null && lockedForMe(desk, this.selfId, this.invites)
  }
}
