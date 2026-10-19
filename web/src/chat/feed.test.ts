import { describe, expect, it } from 'vitest'
import { ZoneMap } from '../game/zones'
import type { ServerMessage } from '../net/protocol'
import { rosterFeed } from './feed'

describe('rosterFeed', () => {
  it('tells listeners after the roster changed, and only then', () => {
    const subscribers: Array<(msg: ServerMessage) => void> = []
    const feed = rosterFeed({ onMessage: (fn) => subscribers.push(fn) })
    const seen: string[][] = []
    feed.onChange(() => seen.push(feed.roster.list().map((p) => p.id)))
    const send = (msg: ServerMessage) => subscribers.forEach((fn) => fn(msg))

    send({ t: 'welcome', d: { selfId: 's', mapId: 'office', tickRate: 20, stepMs: 150, players: [{ id: 's', name: 'Eu', x: 0, y: 0, dir: 'down' }] } })
    send({ t: 'pong', d: { ts: 1 } })
    send({ t: 'joined', d: { id: 'a', name: 'Ana', x: 1, y: 0, dir: 'down' } })
    expect(seen).toEqual([['s'], ['s', 'a']])

    feed.setZones(new ZoneMap(4, 4, [{ id: 'z', name: 'Z', kind: 'meeting', tiles: { x0: 1, y0: 0, x1: 2, y1: 1 } }]))
    expect(seen).toHaveLength(3)
    feed.setZones(new ZoneMap(4, 4, [{ id: 'z', name: 'Z', kind: 'meeting', tiles: { x0: 1, y0: 0, x1: 2, y1: 1 } }]))
    expect(seen).toHaveLength(3)
  })
})
