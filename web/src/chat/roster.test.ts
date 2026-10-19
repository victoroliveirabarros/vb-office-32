import { describe, expect, it } from 'vitest'
import { ZoneMap } from '../game/zones'
import type { Player, ServerMessage } from '../net/protocol'
import { Roster } from './roster'

const player = (id: string, name: string, x = 0, y = 0): Player => ({ id, name, x, y, dir: 'down' })

// Tiles 0–1 × 0–1 are a meeting room, 3 × 0 a booth.
const zones = new ZoneMap(5, 5, [
  { id: 'sala', name: 'Sala', kind: 'meeting', tiles: { x0: 0, y0: 0, x1: 2, y1: 2 } },
  { id: 'cab', name: 'Cabine', kind: 'private', tiles: { x0: 3, y0: 0, x1: 4, y1: 1 } },
])
const SALA = { id: 'sala', name: 'Sala', kind: 'meeting' } as const

const moved = (id: string, x: number, y: number): ServerMessage => ({ t: 'state', d: { tick: 1, ack: 0, players: [{ id, x, y, dir: 'down' }] } })

const welcome = (selfId: string, players: Player[]): ServerMessage => ({
  t: 'welcome',
  d: { selfId, mapId: 'office', tickRate: 20, stepMs: 150, players },
})

describe('Roster', () => {
  it('lists self first, then names in pt-BR order', () => {
    const roster = new Roster()
    roster.handle(welcome('z', [player('z', 'Zé'), player('b', 'bruno'), player('a', 'Álvaro'), player('c', 'Ana')]))
    expect(roster.list().map((p) => p.name)).toEqual(['Zé', 'Álvaro', 'Ana', 'bruno'])
    expect(roster.list()[0]).toEqual({ id: 'z', name: 'Zé', label: 'Zé', self: true, nearby: false, room: null })
  })

  it('breaks name ties by id so the order is stable', () => {
    const roster = new Roster()
    roster.handle(welcome('s', [player('s', 'Eu'), player('guest:b', 'Ana'), player('guest:a', 'ana')]))
    expect(roster.list().map((p) => p.id)).toEqual(['s', 'guest:a', 'guest:b'])
  })

  it('follows joined, left and nearby', () => {
    const roster = new Roster()
    roster.handle(welcome('s', [player('s', 'Eu')]))
    expect(roster.handle({ t: 'joined', d: player('a', 'Ana') })).toBe(true)
    expect(roster.handle({ t: 'nearby', d: { ids: ['a', 's'] } })).toBe(true)
    expect(roster.online('a')).toBe(true)
    expect(roster.name('a')).toBe('Ana')
    expect(roster.nearby()).toEqual(['a'])
    expect(roster.list().find((p) => p.id === 'a')?.nearby).toBe(true)

    expect(roster.handle({ t: 'left', d: { id: 'a' } })).toBe(true)
    expect(roster.online('a')).toBe(false)
    expect(roster.nearby()).toEqual([])
    expect(roster.handle({ t: 'left', d: { id: 'a' } })).toBe(false)
  })

  it('starts over on welcome', () => {
    const roster = new Roster()
    roster.handle(welcome('s', [player('s', 'Eu'), player('a', 'Ana')]))
    roster.handle({ t: 'nearby', d: { ids: ['a'] } })
    roster.handle(welcome('s', [player('s', 'Eu')]))
    expect(roster.list().map((p) => p.id)).toEqual(['s'])
    expect(roster.nearby()).toEqual([])
  })

  it('ignores unrelated messages', () => {
    const roster = new Roster()
    expect(roster.handle({ t: 'pong', d: { ts: 1 } })).toBe(false)
  })

  it('places others in rooms by position and itself by the zone message', () => {
    const roster = new Roster()
    roster.handle(welcome('s', [player('s', 'Eu', 4, 4), player('a', 'Ana', 1, 1), player('b', 'Bia', 4, 4)]))
    expect(roster.roomOf('a')).toBeNull()
    expect(roster.setZones(zones)).toBe(true)
    expect(roster.roomOf('a')).toEqual(SALA)
    expect(roster.roomOf('s')).toBeNull()
    expect(roster.inOurRoom('a')).toBe(false)

    expect(roster.handle({ t: 'zone', d: { id: 'sala', name: 'Sala', kind: 'meeting' } })).toBe(true)
    expect(roster.handle({ t: 'zone', d: { id: 'sala', name: 'Sala', kind: 'meeting' } })).toBe(false)
    expect(roster.room).toEqual(SALA)
    expect(roster.roomOf('s')).toEqual(SALA)
    expect(roster.inOurRoom('a')).toBe(true)
    expect(roster.inOurRoom('s')).toBe(false)
    expect(roster.list().map((p) => [p.id, p.room?.id ?? null])).toEqual([['s', 'sala'], ['a', 'sala'], ['b', null]])

    expect(roster.handle(moved('a', 0, 1))).toBe(false)
    expect(roster.handle(moved('a', 2, 1))).toBe(true)
    expect(roster.inOurRoom('a')).toBe(false)
    expect(roster.handle(moved('b', 3, 0))).toBe(true)
    expect(roster.roomOf('b')?.name).toBe('Cabine')
    expect(roster.handle(moved('s', 1, 1))).toBe(false)

    expect(roster.handle({ t: 'zone', d: { id: '' } })).toBe(true)
    expect(roster.room).toBeNull()
    roster.handle({ t: 'left', d: { id: 'b' } })
    expect(roster.roomOf('b')).toBeNull()
    expect(roster.handle(moved('b', 3, 0))).toBe(false)
  })

  it('places whoever joins', () => {
    const roster = new Roster()
    roster.setZones(zones)
    roster.handle(welcome('s', [player('s', 'Eu', 4, 4)]))
    roster.handle({ t: 'zone', d: { id: 'cab', name: 'Cabine', kind: 'private' } })
    roster.handle({ t: 'joined', d: player('a', 'Ana', 3, 0) })
    expect(roster.inOurRoom('a')).toBe(true)
  })

  it('tells repeated names apart in labels only', () => {
    const roster = new Roster()
    roster.handle(welcome('s', [player('s', 'Eu'), player('oidc:1', 'Ana'), player('oidc:2', 'Bia')]))
    expect(roster.label('oidc:1')).toBe('Ana')
    roster.handle({ t: 'joined', d: player('oidc:3', 'ana') })
    expect(roster.label('oidc:1')).toMatch(/^Ana #[0-9a-z]{4}$/)
    expect(roster.label('oidc:3')).toMatch(/^ana #[0-9a-z]{4}$/)
    expect(roster.name('oidc:1')).toBe('Ana')
    expect(roster.list().find((p) => p.id === 'oidc:1')?.label).toBe(roster.label('oidc:1'))
    expect(roster.labelFor('oidc:9', 'Bia')).toMatch(/^Bia #/)
    roster.handle({ t: 'left', d: { id: 'oidc:3' } })
    expect(roster.label('oidc:1')).toBe('Ana')
    expect(roster.label('oidc:3')).toBeUndefined()
  })
})
