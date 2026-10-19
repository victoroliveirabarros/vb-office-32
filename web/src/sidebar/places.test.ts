import { describe, expect, it } from 'vitest'
import { DEFAULT_APPEARANCE } from '../avatar/appearance'
import type { Person } from '../chat/roster'
import { ZoneMap } from '../game/zones'
import { countText, filterPeople, fold, OPEN_FLOOR, placeOf, places } from './places'

const person = (id: string, over: Partial<Person> = {}): Person => ({
  id,
  name: id,
  label: id,
  self: false,
  nearby: false,
  room: null,
  area: null,
  look: DEFAULT_APPEARANCE,
  ...over,
})

const map = new ZoneMap(
  10,
  10,
  [
    { id: 'reuniao', name: 'Sala de reunião', kind: 'meeting', tiles: { x0: 0, y0: 0, x1: 2, y1: 2 } },
    { id: 'privada', name: 'Sala privada', kind: 'private', tiles: { x0: 3, y0: 0, x1: 4, y1: 1 } },
  ],
  [
    { id: 'copa', name: 'Copa', tiles: { x0: 5, y0: 0, x1: 8, y1: 2 } },
    { id: 'escritorio', name: 'Escritório aberto', tiles: { x0: 0, y0: 3, x1: 10, y1: 10 } },
  ],
)
const REUNIAO = { id: 'reuniao', name: 'Sala de reunião', kind: 'meeting' } as const

describe('places', () => {
  it('says where someone is: room, area, else the open floor', () => {
    expect(placeOf({ room: REUNIAO, area: null }).name).toBe('Sala de reunião')
    expect(placeOf({ room: null, area: { id: 'copa', name: 'Copa' } }).name).toBe('Copa')
    expect(placeOf({ room: null, area: null })).toEqual(OPEN_FLOOR)
  })

  it('lists the rooms, then the open floor and the other areas, with who is in each', () => {
    const list = places(map, [
      person('eu', { self: true, area: { id: 'copa', name: 'Copa' } }),
      person('ana', { room: REUNIAO }),
      person('bia'),
      person('cris', { area: { id: 'escritorio', name: 'Escritório aberto' } }),
    ])
    expect(list.map((p) => [p.id, p.kind, p.people.map((x) => x.id), p.here])).toEqual([
      ['reuniao', 'meeting', ['ana'], false],
      ['privada', 'private', [], false],
      ['escritorio', 'open', ['bia', 'cris'], false],
      ['copa', 'open', ['eu'], true],
    ])
    expect(list[0]?.tiles).toEqual({ x0: 0, y0: 0, x1: 2, y1: 2 })
  })

  it('keeps an open floor even on a map without areas', () => {
    const bare = new ZoneMap(4, 4, [])
    expect(places(bare, [person('a')])).toEqual([{ id: 'escritorio', name: 'Escritório aberto', kind: 'open', tiles: null, people: [person('a')], here: false }])
  })

  it('counts people', () => {
    expect(countText(0)).toBe('Vazia')
    expect(countText(1)).toBe('1 pessoa')
    expect(countText(5)).toBe('5 pessoas')
  })

  it('searches names without accents or case', () => {
    const people = [person('1', { label: 'João' }), person('2', { label: 'Ana #k3f9' }), person('3', { label: 'Joana' })]
    expect(fold(' ÁRVORE ')).toBe('arvore')
    expect(filterPeople(people, 'joa').map((p) => p.id)).toEqual(['1', '3'])
    expect(filterPeople(people, 'JOÃO').map((p) => p.id)).toEqual(['1'])
    expect(filterPeople(people, '  ').map((p) => p.id)).toEqual(['1', '2', '3'])
    expect(filterPeople(people, 'zé')).toEqual([])
  })
})
