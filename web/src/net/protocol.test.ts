import { describe, expect, it } from 'vitest'
import { encode, normalizeName, parseServerMessage } from './protocol'

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

  it('parses a media grant', () => {
    const raw = JSON.stringify({ t: 'media', d: { url: 'wss://media.example', token: 'a.b.c', expiresAt: 1767269400000 } })
    expect(parseServerMessage(raw)).toEqual(JSON.parse(raw))
  })

  it('parses nearby, including the empty set', () => {
    for (const ids of [[], ['guest:ana', 'oidc:42']]) {
      const raw = JSON.stringify({ t: 'nearby', d: { ids } })
      expect(parseServerMessage(raw)).toEqual({ t: 'nearby', d: { ids } })
    }
  })

  it('rejects malformed media and nearby', () => {
    expect(parseServerMessage('{"t":"media","d":{"url":"wss://m","token":"t"}}')).toBeNull()
    expect(parseServerMessage('{"t":"media","d":{"url":"wss://m","token":"t","expiresAt":"1"}}')).toBeNull()
    expect(parseServerMessage('{"t":"media","d":{"url":"wss://m","token":"","expiresAt":1}}')).toBeNull()
    expect(parseServerMessage('{"t":"media","d":{"url":1,"token":"t","expiresAt":1}}')).toBeNull()
    expect(parseServerMessage('{"t":"nearby","d":{}}')).toBeNull()
    expect(parseServerMessage('{"t":"nearby","d":{"ids":null}}')).toBeNull()
    expect(parseServerMessage('{"t":"nearby","d":{"ids":["a",2]}}')).toBeNull()
  })

  it('parses zones, treating unknown kinds as private', () => {
    expect(parseServerMessage('{"t":"zone","d":{"id":"sala-1","name":"Sala 1","kind":"meeting"}}')).toEqual({
      t: 'zone',
      d: { id: 'sala-1', name: 'Sala 1', kind: 'meeting' },
    })
    expect(parseServerMessage('{"t":"zone","d":{"id":"cab","name":"Cabine","kind":"lounge"}}')).toEqual({
      t: 'zone',
      d: { id: 'cab', name: 'Cabine', kind: 'private' },
    })
    expect(parseServerMessage('{"t":"zone","d":{"id":"cab"}}')).toEqual({ t: 'zone', d: { id: 'cab', kind: 'private' } })
    expect(parseServerMessage('{"t":"zone","d":{"id":"","name":"x","kind":"meeting"}}')).toEqual({ t: 'zone', d: { id: '' } })
  })

  it('rejects malformed zones', () => {
    expect(parseServerMessage('{"t":"zone","d":{}}')).toBeNull()
    expect(parseServerMessage('{"t":"zone","d":{"id":1}}')).toBeNull()
    expect(parseServerMessage('{"t":"zone","d":{"id":"a","name":2}}')).toBeNull()
  })

  it('parses chat messages, keeping only known fields', () => {
    const everyone = { id: 'k1', at: 1767269400000, from: 'guest:ana', fromName: 'Ana', scope: 'everyone', text: '<b>oi</b>' }
    expect(parseServerMessage(JSON.stringify({ t: 'chat', d: { ...everyone, extra: 1 } }))).toEqual({ t: 'chat', d: everyone })
    const echo = { ...everyone, scope: 'direct', to: 'guest:bia', cid: 'c1' }
    expect(parseServerMessage(JSON.stringify({ t: 'chat', d: echo }))).toEqual({ t: 'chat', d: echo })
    expect(parseServerMessage(JSON.stringify({ t: 'chat', d: { ...everyone, to: null, cid: null } }))).toEqual({ t: 'chat', d: everyone })
  })

  it('rejects malformed chat messages', () => {
    const ok = { id: 'k1', at: 1, from: 'a', fromName: 'A', scope: 'nearby', text: 'x' }
    for (const bad of [
      { ...ok, id: '' },
      { ...ok, at: 1.5 },
      { ...ok, scope: 'all' },
      { ...ok, text: 1 },
      { ...ok, fromName: undefined },
      { ...ok, to: 'b' },
      { ...ok, scope: 'direct' },
      { ...ok, cid: 3 },
    ]) {
      expect(parseServerMessage(JSON.stringify({ t: 'chat', d: bad }))).toBeNull()
    }
  })

  it('parses chat history, skipping bad entries', () => {
    const ok = { id: 'k1', at: 1, from: 'a', fromName: 'A', scope: 'everyone', text: 'x' }
    expect(parseServerMessage(JSON.stringify({ t: 'chatHistory', d: { messages: [ok, { id: 2 }] } }))).toEqual({
      t: 'chatHistory',
      d: { messages: [ok] },
    })
    expect(parseServerMessage('{"t":"chatHistory","d":{"messages":[]}}')).toEqual({ t: 'chatHistory', d: { messages: [] } })
    expect(parseServerMessage('{"t":"chatHistory","d":{}}')).toBeNull()
  })

  it('parses chat errors, mapping unknown reasons to invalid', () => {
    for (const reason of ['rate_limited', 'too_long', 'empty', 'offline', 'invalid']) {
      expect(parseServerMessage(JSON.stringify({ t: 'chatError', d: { cid: 'c1', reason } }))).toEqual({ t: 'chatError', d: { cid: 'c1', reason } })
    }
    expect(parseServerMessage('{"t":"chatError","d":{"cid":"c1","reason":"new"}}')).toEqual({ t: 'chatError', d: { cid: 'c1', reason: 'invalid' } })
    expect(parseServerMessage('{"t":"chatError","d":{"reason":"empty"}}')).toBeNull()
  })

  it('parses players with and without an appearance', () => {
    const look = { skin: 4, hair: 2, hairColor: 7, shirt: 1, pants: 3, acc: 2 }
    const ana = { id: 'guest:ana', name: 'Ana', x: 3, y: 4, dir: 'down' }
    expect(parseServerMessage(JSON.stringify({ t: 'joined', d: { ...ana, appearance: look } }))).toEqual({ t: 'joined', d: { ...ana, appearance: look } })
    expect(parseServerMessage(JSON.stringify({ t: 'joined', d: ana }))).toEqual({ t: 'joined', d: ana })
    expect(parseServerMessage(JSON.stringify({ t: 'joined', d: { ...ana, appearance: null } }))).toEqual({ t: 'joined', d: ana })
    // A broken look costs the look, not the player.
    expect(parseServerMessage(JSON.stringify({ t: 'joined', d: { ...ana, appearance: { skin: -1 } } }))).toEqual({ t: 'joined', d: ana })
    const welcome = { selfId: 'guest:ana', mapId: 'office', tickRate: 20, stepMs: 150, players: [{ ...ana, appearance: { skin: 1 } }, { ...ana, id: 'b' }] }
    expect(parseServerMessage(JSON.stringify({ t: 'welcome', d: welcome }))).toEqual({
      t: 'welcome',
      d: { ...welcome, players: [{ ...ana, appearance: { skin: 1, hair: 0, hairColor: 0, shirt: 0, pants: 0, acc: 0 } }, { ...ana, id: 'b' }] },
    })
    expect(parseServerMessage(JSON.stringify({ t: 'welcome', d: { ...welcome, players: [{ id: 'x' }] } }))).toBeNull()
  })

  it('parses appearance changes', () => {
    const look = { skin: 0, hair: 4, hairColor: 5, shirt: 6, pants: 2, acc: 1 }
    expect(parseServerMessage(JSON.stringify({ t: 'appearance', d: { id: 'guest:bia', appearance: look } }))).toEqual({
      t: 'appearance',
      d: { id: 'guest:bia', appearance: look },
    })
    expect(parseServerMessage(JSON.stringify({ t: 'appearance', d: { id: 'b', appearance: { ...look, hair: 40 } } }))).toEqual({
      t: 'appearance',
      d: { id: 'b', appearance: { ...look, hair: 0 } },
    })
    for (const bad of [{ appearance: look }, { id: 1, appearance: look }, { id: 'b' }, { id: 'b', appearance: { skin: 300 } }, { id: 'b', appearance: [] }]) {
      expect(parseServerMessage(JSON.stringify({ t: 'appearance', d: bad })), JSON.stringify(bad)).toBeNull()
    }
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

describe('encode', () => {
  it('sends an appearance as its fields', () => {
    const look = { skin: 1, hair: 2, hairColor: 3, shirt: 4, pants: 0, acc: 1 }
    expect(JSON.parse(encode({ t: 'appearance', d: look }))).toEqual({ t: 'appearance', d: look })
  })
})
