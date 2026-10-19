import { isNumber, isRecord, isString } from '../guards'
import type { Zone, ZoneKind } from '../net/protocol'
import { TILE_SIZE } from '../scenes/assets'

// The tiles a zone covers, as [x0, x1) × [y0, y1).
export type TileRect = { x0: number; y0: number; x1: number; y1: number }

export type MapZone = { id: string; name: string; kind: ZoneKind; tiles: TileRect }

// Room is a zone someone is in, as shown.
export type Room = { id: string; name: string; kind: ZoneKind }

// ZoneMap mirrors internal/tilemap for display only; the server decides who
// hears whom. Objects the server would refuse are skipped, not fatal.
export class ZoneMap {
  private readonly at: Int16Array

  constructor(
    readonly width: number,
    readonly height: number,
    readonly zones: readonly MapZone[],
  ) {
    this.at = new Int16Array(width * height).fill(-1)
    zones.forEach((zone, i) => {
      const { x0, y0, x1, y1 } = zone.tiles
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) this.at[y * width + x] = i
    })
  }

  static empty(): ZoneMap {
    return new ZoneMap(0, 0, [])
  }

  static fromTiled(map: unknown): ZoneMap {
    if (!isRecord(map) || !isNumber(map.width) || !isNumber(map.height) || !Array.isArray(map.layers)) return ZoneMap.empty()
    const { width, height } = map
    const layer = map.layers.find((l: unknown) => isRecord(l) && l.name === 'zones' && l.type === 'objectgroup')
    if (!isRecord(layer) || !Array.isArray(layer.objects)) return new ZoneMap(width, height, [])

    const zones: MapZone[] = []
    const taken = new Set<number>()
    const ids = new Set<string>()
    for (const obj of layer.objects) {
      const zone = toZone(obj, width, height)
      if (!zone || ids.has(zone.id)) continue
      const tiles = covered(zone.tiles, width)
      if (tiles.some((t) => taken.has(t))) continue
      tiles.forEach((t) => taken.add(t))
      ids.add(zone.id)
      zones.push(zone)
    }
    return new ZoneMap(width, height, zones)
  }

  zoneAt(x: number, y: number): MapZone | null {
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= this.width || y >= this.height) return null
    return this.zones[this.at[y * this.width + x] ?? -1] ?? null
  }

  byId(id: string): MapZone | null {
    return this.zones.find((z) => z.id === id) ?? null
  }
}

function covered({ x0, y0, x1, y1 }: TileRect, width: number): number[] {
  const tiles: number[] = []
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) tiles.push(y * width + x)
  return tiles
}

function property(obj: Record<string, unknown>, name: string): string | null {
  if (!Array.isArray(obj.properties)) return null
  const prop: unknown = obj.properties.find((p: unknown) => isRecord(p) && p.name === name)
  return isRecord(prop) && isString(prop.value) ? prop.value : null
}

// Tiles whose center lies in [start, start+size): the first is the smallest
// t with t*T + T/2 >= start, the end the smallest with t*T + T/2 >= start+size.
function span(start: number, size: number, limit: number): [number, number] {
  const first = (edge: number) => Math.min(limit, Math.max(0, Math.ceil((edge - TILE_SIZE / 2) / TILE_SIZE)))
  return [first(start), first(start + size)]
}

function toZone(obj: unknown, width: number, height: number): MapZone | null {
  if (!isRecord(obj)) return null
  if (obj.point === true || obj.ellipse === true || obj.polygon != null || obj.polyline != null || obj.text != null || (obj.gid ?? 0) !== 0) return null
  if ((obj.rotation ?? 0) !== 0) return null
  const { x, y, width: w, height: h } = obj
  if (!isNumber(x) || !isNumber(y) || !isNumber(w) || !isNumber(h) || w <= 0 || h <= 0) return null
  const id = property(obj, 'id')
  const name = isString(obj.name) ? obj.name : ''
  if (!id || name.trim() === '') return null

  const [x0, x1] = span(x, w, width)
  const [y0, y1] = span(y, h, height)
  if (x0 >= x1 || y0 >= y1) return null
  return { id, name, kind: property(obj, 'kind') === 'meeting' ? 'meeting' : 'private', tiles: { x0, y0, x1, y1 } }
}

// The server's zone message as a Room; null outside every zone.
export function toRoom(zone: Zone): Room | null {
  return zone.id === '' ? null : { id: zone.id, name: zone.name ?? zone.id, kind: zone.kind ?? 'private' }
}

export function sameRoom(a: Room | null, b: Room | null): boolean {
  return a === b || (a !== null && b !== null && a.id === b.id && a.name === b.name && a.kind === b.kind)
}
