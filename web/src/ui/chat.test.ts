import { describe, expect, it } from 'vitest'
import { clean } from '../chat/clean'
import type { Person } from '../chat/roster'
import type { Tab } from '../chat/state'
import type { Room } from '../game/zones'
import { counterText, failureText, personAriaLabel, personTag, tabAriaLabel, tabLabel, tabNotice } from './chat'

const SALA: Room = { id: 'sala-1', name: 'Sala 1', kind: 'meeting' }
const SALA2: Room = { id: 'sala-2', name: 'Sala 2', kind: 'meeting' }

const roster = (names: Record<string, string>, nearby: string[] = [], room: Room | null = null) => ({
  online: (id: string) => id in names,
  label: (id: string) => names[id],
  labelFor: (id: string, name: string) => `${name} (${id})`,
  nearby: () => nearby,
  room,
  inOurRoom: (id: string) => room !== null && nearby.includes(id),
})

const person = (over: Partial<Person>): Person => ({ id: 'a', name: 'Ana', label: 'Ana', self: false, nearby: false, room: null, ...over })

const tab = (over: Partial<Tab>): Tab => ({ key: 'everyone', scope: 'everyone', peer: null, peerName: '', entries: [], unread: 0, ...over })
const dm = tab({ key: 'dm:guest:ana', scope: 'direct', peer: 'guest:ana', peerName: 'Ana antiga' })

describe('chat view', () => {
  it('labels tabs, preferring the live name', () => {
    expect(tabLabel(tab({}), roster({}))).toBe('Todos')
    expect(tabLabel(tab({ key: 'nearby', scope: 'nearby' }), roster({}))).toBe('Perto')
    expect(tabLabel(dm, roster({ 'guest:ana': 'Ana' }))).toBe('Ana')
    expect(tabLabel(dm, roster({}))).toBe('Ana antiga (guest:ana)')
  })

  it('names the nearby tab after the room we are in', () => {
    expect(tabLabel(tab({ key: 'nearby', scope: 'nearby' }), roster({}, [], SALA))).toBe('Sala 1')
  })

  it('puts unread counts in the accessible name', () => {
    expect(tabAriaLabel('Todos', 0)).toBe('Todos')
    expect(tabAriaLabel('Todos', 1)).toBe('Todos, 1 não lida')
    expect(tabAriaLabel('Perto', 3)).toBe('Perto, 3 não lidas')
  })

  it('warns that everyone is seen by whoever joins later', () => {
    expect(tabNotice(tab({}), roster({}))).toEqual({ text: expect.stringContaining('quem entrar') as string, canSend: true })
  })

  it('says who is nearby, or that nobody is', () => {
    const nearby = tab({ key: 'nearby', scope: 'nearby' })
    expect(tabNotice(nearby, roster({})).text).toContain('Ninguém perto')
    expect(tabNotice(nearby, roster({ a: 'Ana', b: 'Bia' }, ['a', 'b'])).text).toBe('Perto de você agora: Ana, Bia.')
  })

  it('warns that only the room sees nearby messages inside one', () => {
    const nearby = tab({ key: 'nearby', scope: 'nearby' })
    expect(tabNotice(nearby, roster({}, [], SALA)).text).toBe('Visível só para quem está na sala. Ninguém mais aqui agora; só você verá.')
    expect(tabNotice(nearby, roster({ a: 'Ana', b: 'Bia' }, ['a', 'b'], SALA)).text).toBe('Visível só para quem está na sala: Ana, Bia.')
  })

  it('tags people in our room, near us or in another room', () => {
    const outside = roster({ a: 'Ana' }, ['a'])
    const inside = roster({ a: 'Ana' }, ['a'], SALA)
    expect(personTag(person({ self: true, room: SALA }), inside)).toBeNull()
    expect(personTag(person({ nearby: true, room: SALA }), inside)).toEqual({ text: 'na sala', kind: 'room' })
    expect(personTag(person({ nearby: true }), outside)).toEqual({ text: 'perto', kind: 'near' })
    expect(personTag(person({ id: 'b', room: SALA2 }), inside)).toEqual({ text: 'Sala 2', kind: 'elsewhere' })
    expect(personTag(person({ id: 'b', room: SALA2 }), outside)).toEqual({ text: 'Sala 2', kind: 'elsewhere' })
    expect(personTag(person({ id: 'b' }), inside)).toBeNull()
  })

  it('says the tag to screen readers', () => {
    expect(personAriaLabel(person({ label: 'Ana #k3f9' }), { text: 'na sala', kind: 'room' })).toBe('Conversar com Ana #k3f9, na sala')
    expect(personAriaLabel(person({}), null)).toBe('Conversar com Ana')
    expect(personAriaLabel(person({ self: true }), null)).toBe('Ana, você')
  })

  it('blocks sending to someone offline', () => {
    expect(tabNotice(dm, roster({ 'guest:ana': 'Ana' }))).toEqual({ text: 'Só você e Ana veem.', canSend: true })
    expect(tabNotice(dm, roster({}))).toEqual({ text: 'Ana antiga (guest:ana) está offline.', canSend: false })
  })

  it('explains failures and counts runes', () => {
    expect(failureText('rate_limited')).toBe('Não enviada: muitas mensagens seguidas, aguarde um pouco')
    expect(failureText(null)).toBe('Não enviada: mensagem recusada')
    expect(counterText(clean('😀😀 '))).toBe('2/500')
  })
})
