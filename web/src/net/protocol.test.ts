import { describe, expect, it } from 'vitest'
import { normalizeName, parseServerMessage } from './protocol'

describe('parseServerMessage', () => {
  it('parses a welcome', () => {
    const raw = JSON.stringify({
      t: 'welcome',
      d: {
        selfId: 'guest:ana',
        mapId: 'office',
        tickRate: 20,
        stepMs: 150,
        players: [{ id: 'guest:ana', name: 'Ana', x: 3, y: 4, dir: 'down' }],
      },
    })
    expect(parseServerMessage(raw)).toEqual(JSON.parse(raw))
  })

  it('parses a state', () => {
    const raw = JSON.stringify({ t: 'state', d: { tick: 9, ack: 2, players: [{ id: 'a', x: 1, y: 1, dir: 'up' }] } })
    expect(parseServerMessage(raw)).toEqual(JSON.parse(raw))
  })

  it('rejects malformed messages', () => {
    expect(parseServerMessage('not json')).toBeNull()
    expect(parseServerMessage('{"t":"nope","d":{}}')).toBeNull()
    expect(parseServerMessage('{"t":"left"}')).toBeNull()
    expect(parseServerMessage('{"t":"joined","d":{"id":"a","name":"A","x":1,"y":1,"dir":"north"}}')).toBeNull()
    expect(parseServerMessage('{"t":"state","d":{"tick":1,"ack":"1","players":[]}}')).toBeNull()
  })
})

describe('normalizeName', () => {
  it('trims and accepts valid names', () => {
    expect(normalizeName('  Ana Maria_1-2 ')).toBe('Ana Maria_1-2')
  })

  it('rejects empty, too long or invalid names', () => {
    expect(normalizeName('   ')).toBeNull()
    expect(normalizeName('a'.repeat(25))).toBeNull()
    expect(normalizeName('ana!')).toBeNull()
  })
})
