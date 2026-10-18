import { describe, expect, it } from 'vitest'
import type { Player, ServerMessage } from '../net/protocol'
import { Roster } from './roster'

const player = (id: string, name: string): Player => ({ id, name, x: 0, y: 0, dir: 'down' })

const welcome = (selfId: string, players: Player[]): ServerMessage => ({
  t: 'welcome',
  d: { selfId, mapId: 'office', tickRate: 20, stepMs: 150, players },
})

describe('Roster', () => {
  it('lists self first, then names in pt-BR order', () => {
    const roster = new Roster()
    roster.handle(welcome('z', [player('z', 'Zé'), player('b', 'bruno'), player('a', 'Álvaro'), player('c', 'Ana')]))
    expect(roster.list().map((p) => p.name)).toEqual(['Zé', 'Álvaro', 'Ana', 'bruno'])
    expect(roster.list()[0]).toEqual({ id: 'z', name: 'Zé', self: true, nearby: false })
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
})
