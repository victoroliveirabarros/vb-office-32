import { describe, expect, it } from 'vitest'
import type { Desk, ServerMessage } from '../net/protocol'
import { deskGate, deskLabel, Desks, lockedForMe } from './desks'
import { ZoneMap } from './zones'

const ana: Desk = { id: 'mesa-01', ownerId: 'guest:ana', ownerName: 'ana', online: true, locked: true }
const bruno: Desk = { id: 'mesa-02', ownerName: 'Bruno Lima', online: false, locked: true }
const free: Desk = { id: 'mesa-03', online: false, locked: false }

const welcome = (selfId: string): ServerMessage => ({ t: 'welcome', d: { selfId, mapId: 'office', tickRate: 20, stepMs: 150, players: [] } })
const desks = (...list: Desk[]): ServerMessage => ({ t: 'desks', d: { desks: list } })
const invite = (desk: string, invited: boolean): ServerMessage => ({ t: 'deskInvite', d: { desk, owner: 'guest:ana', ownerName: 'ana', invited } })

describe('lockedForMe', () => {
  it('locks a desk with an owner to everyone but the owner and the guests', () => {
    expect(lockedForMe(ana, 'guest:eve', new Set())).toBe(true)
    expect(lockedForMe(ana, 'guest:ana', new Set())).toBe(false)
    expect(lockedForMe(ana, 'guest:eve', new Set(['mesa-01']))).toBe(false)
    expect(lockedForMe(ana, null, new Set())).toBe(true)
  })

  it('locks a desk whose owner never connected, and never a free one', () => {
    expect(lockedForMe(bruno, 'guest:bruno', new Set())).toBe(true)
    expect(lockedForMe(free, 'guest:eve', new Set())).toBe(false)
    expect(lockedForMe(free, null, new Set())).toBe(false)
  })
})

describe('deskLabel', () => {
  it('names a desk after its owner, otherwise after the zone', () => {
    expect(deskLabel({ name: 'Mesa 1' }, ana)).toBe('Mesa de ana')
    expect(deskLabel({ name: 'Mesa 2' }, bruno)).toBe('Mesa de Bruno Lima')
    expect(deskLabel({ name: 'Mesa 3' }, free)).toBe('Mesa 3')
    expect(deskLabel({ name: 'Mesa 4' }, null)).toBe('Mesa 4')
  })

  it('does not say "Mesa de Mesa 7" for an owner known only by the zone', () => {
    expect(deskLabel({ name: 'Mesa 7' }, { id: 'mesa-07', ownerName: 'Mesa 7', online: false, locked: true })).toBe('Mesa 7')
  })
})

describe('deskGate', () => {
  // Two desks side by side on row 1, a meeting room on row 3.
  const zones = new ZoneMap(6, 4, [
    { id: 'mesa-01', name: 'Mesa 1', kind: 'desk', tiles: { x0: 0, y0: 1, x1: 2, y1: 2 } },
    { id: 'mesa-02', name: 'Mesa 2', kind: 'desk', tiles: { x0: 2, y0: 1, x1: 4, y1: 2 } },
    { id: 'sala', name: 'Sala', kind: 'meeting', tiles: { x0: 0, y0: 3, x1: 6, y1: 4 } },
  ])
  const gate = deskGate(zones, (id) => id === 'mesa-01')

  it('refuses entering a locked desk, from outside or from the next one', () => {
    expect(gate({ x: 0, y: 0 }, { x: 0, y: 1 })).toBe(false)
    expect(gate({ x: 2, y: 1 }, { x: 1, y: 1 })).toBe(false)
  })

  it('lets us walk inside it, leave it and go anywhere else', () => {
    expect(gate({ x: 0, y: 1 }, { x: 1, y: 1 })).toBe(true)
    expect(gate({ x: 1, y: 1 }, { x: 2, y: 1 })).toBe(true)
    expect(gate({ x: 1, y: 1 }, { x: 1, y: 0 })).toBe(true)
    expect(gate({ x: 2, y: 0 }, { x: 2, y: 1 })).toBe(true)
    expect(gate({ x: 0, y: 2 }, { x: 0, y: 3 })).toBe(true)
    expect(gate({ x: 4, y: 0 }, { x: 5, y: 0 })).toBe(true)
  })
})

describe('Desks', () => {
  it('follows the desks, our guests and our invites', () => {
    const d = new Desks()
    expect(d.handle(welcome('guest:eve'))).toBe(true)
    expect(d.handle(desks(ana, bruno, free))).toBe(true)
    expect(d.get('mesa-02')).toEqual(bruno)
    expect(d.get('x')).toBeNull()
    expect(d.mine()).toBeNull()
    expect(d.lockedForMe('mesa-01')).toBe(true)
    expect(d.lockedForMe('mesa-03')).toBe(false)
    expect(d.lockedForMe('reuniao')).toBe(false)

    expect(d.handle(invite('mesa-01', true))).toBe(true)
    expect(d.handle(invite('mesa-01', true))).toBe(false)
    expect(d.lockedForMe('mesa-01')).toBe(false)
    expect(d.handle(invite('mesa-01', false))).toBe(true)
    expect(d.lockedForMe('mesa-01')).toBe(true)
    expect(d.handle({ t: 'pong', d: { ts: 1 } })).toBe(false)
  })

  it('knows our own desk and who we invited to it', () => {
    const d = new Desks()
    d.handle(welcome('guest:ana'))
    d.handle(desks(ana, free))
    d.handle({ t: 'deskGuests', d: { desk: 'mesa-01', guests: [{ id: 'guest:eve', name: 'eve', online: true }] } })
    expect(d.mine()).toEqual(ana)
    expect(d.invited('guest:eve')).toBe(true)
    expect(d.invited('guest:bob')).toBe(false)
    expect(d.lockedForMe('mesa-01')).toBe(false)

    // Someone else took it over: no desk, no guests.
    d.handle(desks({ ...ana, ownerId: 'guest:outra' }))
    expect(d.mine()).toBeNull()
    expect(d.guests()).toEqual([])
  })

  it('forgets the guests and invites on a new welcome, which the server sends again', () => {
    const d = new Desks()
    d.handle(welcome('guest:ana'))
    d.handle(desks(ana))
    d.handle({ t: 'deskGuests', d: { desk: 'mesa-01', guests: [{ id: 'guest:eve', name: 'eve', online: true }] } })
    d.handle(invite('mesa-02', true))
    d.handle(welcome('guest:ana'))
    expect(d.guests()).toEqual([])
    expect(d.all()).toEqual([ana])
    expect(d.handle(invite('mesa-02', true))).toBe(true)
  })
})
