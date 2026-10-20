import { describe, expect, it } from 'vitest'
import { DEFAULT_APPEARANCE } from '../avatar/appearance'
import type { Person } from '../chat/roster'
import { ZoneMap } from '../game/zones'
import { Desks } from '../game/desks'
import { countText, deskGuestRows, deskPlaces, deskStatusText, filterPeople, fold, kindHint, kindText, OPEN_FLOOR, placeOf, places } from './places'

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
    { id: 'mesa-01', name: 'Mesa 1', kind: 'desk', tiles: { x0: 3, y0: 4, x1: 6, y1: 6 } },
    { id: 'mesa-02', name: 'Mesa 2', kind: 'desk', tiles: { x0: 6, y0: 4, x1: 9, y1: 6 } },
    { id: 'mesa-03', name: 'Mesa 3', kind: 'desk', tiles: { x0: 3, y0: 6, x1: 6, y1: 8 } },
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

  it('lists the rooms, then the open floor and the other areas, with who is in each, but not the desks', () => {
    const list = places(map, [
      person('eu', { self: true, area: { id: 'copa', name: 'Copa' } }),
      person('ana', { room: REUNIAO }),
      person('bia'),
      person('cris', { area: { id: 'escritorio', name: 'Escritório aberto' } }),
      person('dani', { room: { id: 'mesa-01', name: 'Mesa 1', kind: 'desk' } }),
    ])
    expect(list.map((p) => [p.id, p.kind, p.people.map((x) => x.id), p.here])).toEqual([
      ['reuniao', 'meeting', ['ana'], false],
      ['privada', 'private', [], false],
      ['escritorio', 'open', ['bia', 'cris'], false],
      ['copa', 'open', ['eu'], true],
    ])
    expect(list[0]?.tiles).toEqual({ x0: 0, y0: 0, x1: 2, y1: 2 })
  })

  it('lists the desks after their owners, with who is at each and whether we may go in', () => {
    const desks = new Desks()
    desks.handle({ t: 'welcome', d: { selfId: 'eu', mapId: 'office', tickRate: 20, stepMs: 150, players: [] } })
    desks.handle({
      t: 'desks',
      d: {
        desks: [
          { id: 'mesa-01', ownerId: 'ana', ownerName: 'Ana Souza', online: true, locked: true },
          { id: 'mesa-02', ownerName: 'Bruno Lima', online: false, locked: true },
          { id: 'mesa-03', online: false, locked: false },
        ],
      },
    })
    const at = (id: string, name: string) => ({ room: { id, name, kind: 'desk' as const } })
    const people = [person('eu', { self: true }), person('ana', at('mesa-01', 'Mesa 1')), person('bia', at('mesa-03', 'Mesa 3'))]
    expect(deskPlaces(map, desks, people).map((d) => [d.id, d.name, d.status, d.lockedForMe, d.people.map((p) => p.id), d.here])).toEqual([
      ['mesa-01', 'Mesa de Ana Souza', 'online', true, ['ana'], false],
      ['mesa-02', 'Mesa de Bruno Lima', 'offline', true, [], false],
      ['mesa-03', 'Mesa 3', 'free', false, ['bia'], false],
    ])
    desks.handle({ t: 'deskInvite', d: { desk: 'mesa-01', owner: 'ana', ownerName: 'Ana Souza', invited: true } })
    const invited = deskPlaces(map, desks, [person('eu', { self: true, ...at('mesa-01', 'Mesa 1') })])[0]
    expect([invited?.lockedForMe, invited?.here]).toEqual([false, true])
    expect(deskPlaces(new ZoneMap(4, 4, []), desks, people)).toEqual([])
    expect((['online', 'offline', 'free'] as const).map(deskStatusText)).toEqual(['Online', 'Offline · fechada', 'Livre'])
  })

  it('marks only our own desk as ours', () => {
    const desks = new Desks()
    desks.handle({ t: 'welcome', d: { selfId: 'ana', mapId: 'office', tickRate: 20, stepMs: 150, players: [] } })
    desks.handle({ t: 'desks', d: { desks: [{ id: 'mesa-01', ownerId: 'ana', ownerName: 'Ana Souza', online: true, locked: true }] } })
    expect(deskPlaces(map, desks, []).map((d) => [d.id, d.own])).toEqual([
      ['mesa-01', true],
      ['mesa-02', false],
      ['mesa-03', false],
    ])
  })

  it('lists our guests, offline ones too, each to be taken back by name', () => {
    const rows = deskGuestRows(
      [
        { id: 'guest:eve', name: 'eve', online: true },
        { id: 'guest:otto', name: 'otto', online: false },
      ],
      (id, name) => (id === 'guest:otto' ? `${name} #2` : name),
    )
    expect(rows).toEqual([
      { id: 'guest:eve', label: 'eve', online: true, status: 'Online', revoke: 'Remover convite de eve' },
      { id: 'guest:otto', label: 'otto #2', online: false, status: 'Offline', revoke: 'Remover convite de otto #2' },
    ])
    expect(deskGuestRows([], (_, name) => name)).toEqual([])
  })

  it('names the kinds, desks included', () => {
    expect(kindText('desk')).toBe('Mesa')
    expect(kindHint('desk')).toBe('Só quem está na mesa ouve e vê.')
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
