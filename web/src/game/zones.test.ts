import { describe, expect, it } from 'vitest'
import office from '../../../maps/office.tmj?raw'
import { ZoneMap } from './zones'

type Obj = Record<string, unknown>

function zone(id: string, x: number, y: number, width: number, height: number, over: Obj = {}): Obj {
  return {
    name: id.toUpperCase(),
    x,
    y,
    width,
    height,
    rotation: 0,
    properties: [
      { name: 'id', type: 'string', value: id },
      { name: 'kind', type: 'string', value: 'meeting' },
    ],
    ...over,
  }
}

const tiled = (objects: Obj[], width = 10, height = 10) => ({
  width,
  height,
  layers: [{ name: 'walls', type: 'tilelayer', data: [] }, { name: 'zones', type: 'objectgroup', objects }],
})

describe('ZoneMap', () => {
  it('holds a tile when its center lies in the half-open rectangle', () => {
    // Centers at 16, 48, 80…: x in [16, 80) holds tiles 0 and 1, not 2.
    const map = ZoneMap.fromTiled(tiled([zone('a', 16, 16, 64, 64)]))
    expect(map.zones[0]?.tiles).toEqual({ x0: 0, y0: 0, x1: 2, y1: 2 })
    expect(map.zoneAt(0, 0)?.id).toBe('a')
    expect(map.zoneAt(1, 1)?.id).toBe('a')
    expect(map.zoneAt(2, 1)).toBeNull()
    expect(map.zoneAt(1, 2)).toBeNull()
  })

  it('leaves out a tile whose center sits just past the edge', () => {
    const map = ZoneMap.fromTiled(tiled([zone('a', 17, 0, 31, 32)]))
    expect(map.zoneAt(0, 0)).toBeNull()
    expect(map.zones).toEqual([])
    const wide = ZoneMap.fromTiled(tiled([zone('a', 17, 0, 32, 32)]))
    expect(wide.zoneAt(1, 0)?.id).toBe('a')
  })

  it('reads name and kind, an unknown kind as private', () => {
    const map = ZoneMap.fromTiled(
      tiled([
        zone('a', 0, 0, 32, 32),
        zone('b', 64, 0, 32, 32, { properties: [{ name: 'id', value: 'b' }, { name: 'kind', value: 'lounge' }] }),
        zone('c', 128, 0, 32, 32, { properties: [{ name: 'id', value: 'c' }] }),
      ]),
    )
    expect(map.zones.map((z) => [z.id, z.name, z.kind])).toEqual([
      ['a', 'A', 'meeting'],
      ['b', 'B', 'private'],
      ['c', 'C', 'private'],
    ])
    expect(map.byId('b')?.kind).toBe('private')
    expect(map.byId('x')).toBeNull()
  })

  it('skips what the server would refuse', () => {
    const map = ZoneMap.fromTiled(
      tiled([
        zone('point', 0, 0, 0, 0, { point: true }),
        zone('ellipse', 0, 0, 32, 32, { ellipse: true }),
        zone('poly', 0, 0, 32, 32, { polygon: [] }),
        zone('tile', 0, 0, 32, 32, { gid: 3 }),
        zone('turned', 0, 0, 32, 32, { rotation: 45 }),
        zone('flat', 0, 0, 32, 0),
        zone('noname', 0, 0, 32, 32, { name: '  ' }),
        zone('noid', 0, 0, 32, 32, { properties: [] }),
        zone('outside', 400, 400, 32, 32),
        zone('ok', 0, 0, 64, 32),
        zone('ok', 0, 64, 32, 32),
        zone('overlap', 32, 0, 32, 64),
      ]),
    )
    expect(map.zones.map((z) => z.id)).toEqual(['ok'])
    expect(map.zoneAt(0, 2)).toBeNull()
    expect(map.zoneAt(1, 1)).toBeNull()
  })

  it('is empty without a zones layer or a usable map', () => {
    expect(ZoneMap.fromTiled({ width: 2, height: 2, layers: [] }).zones).toEqual([])
    expect(ZoneMap.fromTiled(null).zoneAt(0, 0)).toBeNull()
    expect(ZoneMap.fromTiled(tiled([zone('a', 0, 0, 32, 32)])).zoneAt(-1, 0)).toBeNull()
    expect(ZoneMap.fromTiled(tiled([zone('a', 0, 0, 32, 32)])).zoneAt(0.5, 0)).toBeNull()
  })

  it('matches maps/office.tmj as the server reads it', () => {
    const map = ZoneMap.fromTiled(JSON.parse(office))
    expect(map.zones).toEqual([
      { id: 'sala-1', name: 'Sala 1', kind: 'meeting', tiles: { x0: 1, y0: 1, x1: 11, y1: 9 } },
      { id: 'sala-2', name: 'Sala 2', kind: 'meeting', tiles: { x0: 12, y0: 1, x1: 22, y1: 9 } },
      { id: 'cabine', name: 'Cabine', kind: 'private', tiles: { x0: 23, y0: 1, x1: 29, y1: 9 } },
    ])
    // Doors on row 9 and the hall stay outside; the tile above a door is in.
    for (const [x, y] of [[6, 9], [17, 9], [25, 9], [26, 9], [6, 11], [9, 16]] as const) expect(map.zoneAt(x, y)).toBeNull()
    expect(map.zoneAt(6, 8)?.id).toBe('sala-1')
    expect(map.zoneAt(17, 8)?.id).toBe('sala-2')
    expect(map.zoneAt(25, 8)?.id).toBe('cabine')
    expect(map.zoneAt(11, 5)).toBeNull()
  })
})
