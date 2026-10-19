import { describe, expect, it } from 'vitest'
import { clean } from '../chat/clean'
import type { Tab } from '../chat/state'
import { counterText, failureText, tabAriaLabel, tabLabel, tabNotice } from './chat'

const roster = (names: Record<string, string>, nearby: string[] = []) => ({
  online: (id: string) => id in names,
  name: (id: string) => names[id],
  nearby: () => nearby,
})

const tab = (over: Partial<Tab>): Tab => ({ key: 'everyone', scope: 'everyone', peer: null, peerName: '', entries: [], unread: 0, ...over })
const dm = tab({ key: 'dm:guest:ana', scope: 'direct', peer: 'guest:ana', peerName: 'Ana antiga' })

describe('chat view', () => {
  it('labels tabs, preferring the live name', () => {
    expect(tabLabel(tab({}), roster({}))).toBe('Todos')
    expect(tabLabel(tab({ key: 'nearby', scope: 'nearby' }), roster({}))).toBe('Perto')
    expect(tabLabel(dm, roster({ 'guest:ana': 'Ana' }))).toBe('Ana')
    expect(tabLabel(dm, roster({}))).toBe('Ana antiga')
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

  it('blocks sending to someone offline', () => {
    expect(tabNotice(dm, roster({ 'guest:ana': 'Ana' }))).toEqual({ text: 'Só você e Ana veem.', canSend: true })
    expect(tabNotice(dm, roster({}))).toEqual({ text: 'Ana antiga está offline.', canSend: false })
  })

  it('explains failures and counts runes', () => {
    expect(failureText('rate_limited')).toBe('Não enviada: muitas mensagens seguidas, aguarde um pouco')
    expect(failureText(null)).toBe('Não enviada: mensagem recusada')
    expect(counterText(clean('😀😀 '))).toBe('2/500')
  })
})
