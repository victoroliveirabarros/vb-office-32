import { DEFAULT_APPEARANCE, sameAppearance } from '../avatar/appearance'
import type { Appearance } from '../avatar/appearance'
import { deskLabel, Desks } from '../game/desks'
import type { Tile } from '../game/grid'
import { sameRoom, toRoom, ZoneMap } from '../game/zones'
import type { Room } from '../game/zones'
import type { Player, ServerMessage } from '../net/protocol'
import { Names } from './names'

/** A named part of the open floor, like the kitchen. */
export type Area = { id: string; name: string }

export type Person = {
  id: string
  name: string
  label: string
  self: boolean
  nearby: boolean
  room: Room | null
  /** Where on the open floor, outside every room. */
  area: Area | null
  look: Appearance
}

const collator = new Intl.Collator('pt-BR', { sensitivity: 'base', numeric: true })

// Roster tracks who is in the space, who is in earshot and which room each
// one is in, from the game socket alone, so chat works with or without
// media. Our own room comes from the server; the others' from their
// positions and the map, both public. A desk is named after its owner.
export class Roster {
  readonly desks = new Desks()
  private selfId: string | null = null
  private readonly names = new Map<string, string>()
  private labels = new Names([])
  private nearbyIds: ReadonlySet<string> = new Set()
  private zones = ZoneMap.empty()
  private readonly places = new Map<string, Tile>()
  private readonly rooms = new Map<string, Room>()
  private readonly areas = new Map<string, Area>()
  private readonly looks = new Map<string, Appearance>()
  private own: Room | null = null

  get self(): string | null {
    return this.selfId
  }

  /** Our own room, as the server last said. */
  get room(): Room | null {
    return this.named(this.own)
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
    const desks = this.desks.handle(msg)
    switch (msg.t) {
      case 'welcome':
        this.selfId = msg.d.selfId
        this.names.clear()
        this.places.clear()
        this.rooms.clear()
        this.areas.clear()
        this.looks.clear()
        for (const p of msg.d.players) this.add(p)
        this.relabel()
        this.nearbyIds = new Set()
        return true
      case 'joined':
        this.add(msg.d)
        this.relabel()
        return true
      case 'left': {
        this.places.delete(msg.d.id)
        this.rooms.delete(msg.d.id)
        this.areas.delete(msg.d.id)
        this.looks.delete(msg.d.id)
        if (!this.names.delete(msg.d.id)) return false
        this.relabel()
        if (this.nearbyIds.has(msg.d.id)) this.nearbyIds = new Set([...this.nearbyIds].filter((id) => id !== msg.d.id))
        return true
      }
      case 'state': {
        let changed = false
        for (const pos of msg.d.players) {
          if (!this.names.has(pos.id)) continue
          if (this.place(pos.id, pos)) changed = true
        }
        return changed
      }
      case 'appearance': {
        const before = this.looks.get(msg.d.id)
        if (!this.names.has(msg.d.id) || (before && sameAppearance(before, msg.d.appearance))) return false
        this.looks.set(msg.d.id, msg.d.appearance)
        return true
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
        return desks
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
    return this.named(id === this.selfId ? this.own : (this.rooms.get(id) ?? null))
  }

  /** The named part of the open floor id stands on, outside every room. */
  areaOf(id: string): Area | null {
    return this.roomOf(id) ? null : (this.areas.get(id) ?? null)
  }

  lookOf(id: string): Appearance {
    return this.looks.get(id) ?? DEFAULT_APPEARANCE
  }

  tileOf(id: string): Tile | null {
    return this.places.get(id) ?? null
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
        area: this.areaOf(id),
        look: this.lookOf(id),
      }))
      .sort((a, b) => Number(b.self) - Number(a.self) || collator.compare(a.name, b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  }

  private add(p: Player): void {
    this.names.set(p.id, p.name)
    if (p.appearance) this.looks.set(p.id, p.appearance)
    this.place(p.id, p)
  }

  // Records where id stands and reports whether its room or area changed;
  // our own room is the server's, so only the area counts for us.
  private place(id: string, tile: Tile): boolean {
    this.places.set(id, { x: tile.x, y: tile.y })
    const zone = this.zones.zoneAt(tile.x, tile.y)
    const area = this.zones.areaAt(tile.x, tile.y)
    const before = this.rooms.get(id)?.id
    const areaBefore = this.areas.get(id)?.id
    if (zone) this.rooms.set(id, { id: zone.id, name: zone.name, kind: zone.kind })
    else this.rooms.delete(id)
    if (area) this.areas.set(id, { id: area.id, name: area.name })
    else this.areas.delete(id)
    return (id !== this.selfId && before !== zone?.id) || areaBefore !== area?.id
  }

  private named(room: Room | null): Room | null {
    return room?.kind === 'desk' ? { ...room, name: deskLabel(room, this.desks.get(room.id)) } : room
  }

  private relabel(): void {
    this.labels = new Names(this.names)
  }
}
