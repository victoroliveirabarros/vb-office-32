import type { Tile } from '../game/grid'
import { sameRoom, toRoom, ZoneMap } from '../game/zones'
import type { Room } from '../game/zones'
import type { ServerMessage } from '../net/protocol'
import { Names } from './names'

export type Person = { id: string; name: string; label: string; self: boolean; nearby: boolean; room: Room | null }

const collator = new Intl.Collator('pt-BR', { sensitivity: 'base', numeric: true })

// Roster tracks who is in the space, who is in earshot and which room each
// one is in, from the game socket alone, so chat works with or without
// media. Our own room comes from the server; the others' from their
// positions and the map, both public.
export class Roster {
  private selfId: string | null = null
  private readonly names = new Map<string, string>()
  private labels = new Names([])
  private nearbyIds: ReadonlySet<string> = new Set()
  private zones = ZoneMap.empty()
  private readonly places = new Map<string, Tile>()
  private readonly rooms = new Map<string, Room>()
  private own: Room | null = null

  get self(): string | null {
    return this.selfId
  }

  /** Our own room, as the server last said. */
  get room(): Room | null {
    return this.own
  }

  /** Sets the map the others' rooms are read from; true when one changed. */
  setZones(zones: ZoneMap): boolean {
    this.zones = zones
    let changed = false
    for (const [id, tile] of this.places) changed = this.place(id, tile) || changed
    return changed
  }

  /** Applies msg and reports whether the roster changed. */
  handle(msg: ServerMessage): boolean {
    switch (msg.t) {
      case 'welcome':
        this.selfId = msg.d.selfId
        this.names.clear()
        this.places.clear()
        this.rooms.clear()
        for (const p of msg.d.players) {
          this.names.set(p.id, p.name)
          this.place(p.id, p)
        }
        this.relabel()
        this.nearbyIds = new Set()
        return true
      case 'joined':
        this.names.set(msg.d.id, msg.d.name)
        this.place(msg.d.id, msg.d)
        this.relabel()
        return true
      case 'left': {
        this.places.delete(msg.d.id)
        this.rooms.delete(msg.d.id)
        if (!this.names.delete(msg.d.id)) return false
        this.relabel()
        if (this.nearbyIds.has(msg.d.id)) this.nearbyIds = new Set([...this.nearbyIds].filter((id) => id !== msg.d.id))
        return true
      }
      case 'state': {
        let changed = false
        for (const pos of msg.d.players) {
          if (!this.names.has(pos.id)) continue
          if (this.place(pos.id, pos) && pos.id !== this.selfId) changed = true
        }
        return changed
      }
      case 'zone': {
        const next = toRoom(msg.d)
        if (sameRoom(next, this.own)) return false
        this.own = next
        return true
      }
      case 'nearby':
        this.nearbyIds = new Set(msg.d.ids.filter((id) => id !== this.selfId))
        return true
      default:
        return false
    }
  }

  online(id: string): boolean {
    return this.names.has(id)
  }

  name(id: string): string | undefined {
    return this.names.get(id)
  }

  /** The name to show for id, told apart from repeated names. */
  label(id: string): string | undefined {
    const name = this.names.get(id)
    return name === undefined ? undefined : this.labels.label(id, name)
  }

  /** The label for someone who may have left, by the name they used. */
  labelFor(id: string, name: string): string {
    return this.labels.label(id, name)
  }

  /** Others in earshot, online only. */
  nearby(): string[] {
    return [...this.nearbyIds].filter((id) => this.names.has(id))
  }

  roomOf(id: string): Room | null {
    return id === this.selfId ? this.own : (this.rooms.get(id) ?? null)
  }

  /** Whether id is another person in our room. */
  inOurRoom(id: string): boolean {
    return this.own !== null && id !== this.selfId && this.rooms.get(id)?.id === this.own.id
  }

  /** Everyone online, self first, then by name in pt-BR order. */
  list(): Person[] {
    return [...this.names]
      .map(([id, name]) => ({
        id,
        name,
        label: this.labels.label(id, name),
        self: id === this.selfId,
        nearby: this.nearbyIds.has(id),
        room: this.roomOf(id),
      }))
      .sort((a, b) => Number(b.self) - Number(a.self) || collator.compare(a.name, b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  }

  // Records where id stands and reports whether its room changed.
  private place(id: string, tile: Tile): boolean {
    this.places.set(id, { x: tile.x, y: tile.y })
    const zone = this.zones.zoneAt(tile.x, tile.y)
    const before = this.rooms.get(id)?.id
    if (zone) this.rooms.set(id, { id: zone.id, name: zone.name, kind: zone.kind })
    else this.rooms.delete(id)
    return before !== zone?.id
  }

  private relabel(): void {
    this.labels = new Names(this.names)
  }
}
