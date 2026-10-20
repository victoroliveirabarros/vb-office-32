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
        zone('d', 192, 0, 32, 32, { properties: [{ name: 'id', value: 'd' }, { name: 'kind', value: 'desk' }] }),
      ]),
    )
    expect(map.zones.map((z) => [z.id, z.name, z.kind])).toEqual([
      ['a', 'A', 'meeting'],
      ['b', 'B', 'private'],
      ['c', 'C', 'private'],
      ['d', 'D', 'desk'],
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
      { id: 'reuniao', name: 'Sala de reunião', kind: 'meeting', tiles: { x0: 12, y0: 1, x1: 26, y1: 9 } },
      { id: 'privada', name: 'Sala privada', kind: 'private', tiles: { x0: 1, y0: 10, x1: 11, y1: 17 } },
      { id: 'ringue', name: 'Ringue de box', kind: 'private', tiles: { x0: 39, y0: 10, x1: 49, y1: 17 } },
      { id: 'mesa-01', name: 'Mesa 1', kind: 'desk', tiles: { x0: 15, y0: 13, x1: 18, y1: 15 } },
      { id: 'mesa-02', name: 'Mesa 2', kind: 'desk', tiles: { x0: 18, y0: 13, x1: 21, y1: 15 } },
      { id: 'mesa-03', name: 'Mesa 3', kind: 'desk', tiles: { x0: 21, y0: 13, x1: 24, y1: 15 } },
      { id: 'mesa-04', name: 'Mesa 4', kind: 'desk', tiles: { x0: 15, y0: 15, x1: 18, y1: 17 } },
      { id: 'mesa-05', name: 'Mesa 5', kind: 'desk', tiles: { x0: 18, y0: 15, x1: 21, y1: 17 } },
      { id: 'mesa-06', name: 'Mesa 6', kind: 'desk', tiles: { x0: 21, y0: 15, x1: 24, y1: 17 } },
      { id: 'mesa-07', name: 'Mesa 7', kind: 'desk', tiles: { x0: 26, y0: 13, x1: 29, y1: 15 } },
      { id: 'mesa-08', name: 'Mesa 8', kind: 'desk', tiles: { x0: 29, y0: 13, x1: 32, y1: 15 } },
      { id: 'mesa-09', name: 'Mesa 9', kind: 'desk', tiles: { x0: 32, y0: 13, x1: 35, y1: 15 } },
      { id: 'mesa-10', name: 'Mesa 10', kind: 'desk', tiles: { x0: 26, y0: 15, x1: 29, y1: 17 } },
      { id: 'mesa-11', name: 'Mesa 11', kind: 'desk', tiles: { x0: 29, y0: 15, x1: 32, y1: 17 } },
      { id: 'mesa-12', name: 'Mesa 12', kind: 'desk', tiles: { x0: 32, y0: 15, x1: 35, y1: 17 } },
    ])
    // Each desk is its chair row and its desk row; the walkways stay open.
    expect(map.zoneAt(16, 13)?.id).toBe('mesa-01')
    expect(map.zoneAt(18, 16)?.id).toBe('mesa-05')
    for (const [x, y] of [[16, 12], [16, 17], [24, 14], [25, 15], [14, 13], [35, 16]] as const) expect(map.zoneAt(x, y)).toBeNull()
    // Doors and the office stay outside; the tile past a door is in.
    for (const [x, y] of [[18, 9], [19, 9], [11, 13], [11, 14], [38, 13], [38, 14], [24, 16], [12, 10]] as const)
      expect(map.zoneAt(x, y)).toBeNull()
    expect(map.zoneAt(18, 8)?.id).toBe('reuniao')
    expect(map.zoneAt(10, 13)?.id).toBe('privada')
    expect(map.zoneAt(39, 14)?.id).toBe('ringue')
    // The kitchen is open: no zone, opening included.
    for (const [x, y] of [[27, 2], [32, 7], [32, 9], [37, 8]] as const) expect(map.zoneAt(x, y)).toBeNull()
  })

  it('reads named areas of the open floor apart from the zones', () => {
    const area = (id: string, x: number, y: number, w: number, h: number) => ({ ...zone(id, x, y, w, h), properties: [{ name: 'id', value: id }] })
    const map = ZoneMap.fromTiled({
      ...tiled([zone('a', 0, 0, 64, 64)]),
      layers: [
        { name: 'zones', type: 'objectgroup', objects: [zone('a', 0, 0, 64, 64)] },
        { name: 'areas', type: 'objectgroup', objects: [area('copa', 64, 0, 64, 64), area('copa', 0, 128, 32, 32), area('x', 96, 0, 64, 32), { name: '', x: 0, y: 0 }] },
      ],
    })
    expect(map.zones.map((z) => z.id)).toEqual(['a'])
    expect(map.areas).toEqual([{ id: 'copa', name: 'COPA', tiles: { x0: 2, y0: 0, x1: 4, y1: 2 } }])
    expect(map.areaAt(3, 1)?.id).toBe('copa')
    expect(map.areaAt(0, 0)).toBeNull()
    expect(map.areaAt(0, 4)).toBeNull()
    expect(map.areaById('copa')?.name).toBe('COPA')
    expect(map.areaById('x')).toBeNull()
    expect(ZoneMap.fromTiled(tiled([])).areas).toEqual([])
  })

  it('names the kitchen and the open office of maps/office.tmj', () => {
    const map = ZoneMap.fromTiled(JSON.parse(office))
    expect(map.areas.map((a) => [a.id, a.name, a.tiles])).toEqual([
      ['copa', 'Copa', { x0: 27, y0: 1, x1: 38, y1: 9 }],
      ['escritorio', 'Escritório aberto', { x0: 12, y0: 10, x1: 38, y1: 24 }],
    ])
    expect(map.areaAt(32, 5)?.id).toBe('copa')
    expect(map.areaAt(24, 16)?.id).toBe('escritorio')
    expect(map.areaAt(32, 9)).toBeNull()
  })
})
