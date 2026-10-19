import { describe, expect, it } from 'vitest'
import type { Chat } from '../net/protocol'
import { ChatState, directKey } from './state'

const SELF = 'guest:eu'

let nextId = 0
function chat(over: Partial<Chat> = {}): Chat {
  return { id: `m${++nextId}`, at: 1000, from: 'guest:ana', fromName: 'Ana', scope: 'everyone', text: 'oi', ...over }
}

function joined(options?: ConstructorParameters<typeof ChatState>[0]): ChatState {
  const state = new ChatState({ now: () => 5, ...options })
  state.welcome(SELF, 'Eu')
  return state
}

function sendOk(state: ChatState, key: Parameters<ChatState['compose']>[0], text: string) {
  const composed = state.compose(key, text)
  if (!composed?.ok) throw new Error('compose failed')
  return composed.msg
}

const texts = (state: ChatState, key: Parameters<ChatState['tab']>[0]) => state.tab(key)?.entries.map((e) => e.text)

describe('ChatState', () => {
  it('routes messages to tabs by scope', () => {
    const state = joined()
    expect(state.receive(chat({ text: 'todos' }))).toBe('everyone')
    expect(state.receive(chat({ scope: 'nearby', text: 'perto' }))).toBe('nearby')
    expect(state.receive(chat({ scope: 'direct', to: SELF, text: 'dm' }))).toBe('dm:guest:ana')
    expect(texts(state, 'everyone')).toEqual(['todos'])
    expect(texts(state, 'nearby')).toEqual(['perto'])
    expect(texts(state, 'dm:guest:ana')).toEqual(['dm'])
  })

  it('keys a direct conversation by the other side', () => {
    const state = joined()
    state.openDirect('guest:bia', 'Bia')
    const msg = sendOk(state, directKey('guest:bia'), 'oi bia')
    expect(msg).toEqual({ cid: msg.cid, scope: 'direct', to: 'guest:bia', text: 'oi bia' })
    expect(state.receive(chat({ from: SELF, fromName: 'Eu', scope: 'direct', to: 'guest:bia', text: 'oi bia', cid: msg.cid }))).toBe(
      'dm:guest:bia',
    )
    expect(state.receive(chat({ from: 'guest:bia', fromName: 'Bia', scope: 'direct', to: SELF, text: 'oi' }))).toBe('dm:guest:bia')
    expect(texts(state, 'dm:guest:bia')).toEqual(['oi bia', 'oi'])
    expect(state.tabs().map((t) => t.key)).toEqual(['everyone', 'nearby', 'dm:guest:bia'])
  })

  it('opens a tab for a direct message received', () => {
    const state = joined()
    state.receive(chat({ scope: 'direct', to: SELF }))
    const tab = state.tab('dm:guest:ana')
    expect(tab).toMatchObject({ scope: 'direct', peer: 'guest:ana', peerName: 'Ana', unread: 1 })
  })

  it('drops direct messages without a usable peer', () => {
    const state = joined()
    expect(state.receive(chat({ scope: 'direct', from: SELF, to: SELF }))).toBeNull()
    const noTo: Chat = { id: 'x', at: 1, from: SELF, fromName: 'Eu', scope: 'direct', text: 'a' }
    expect(state.receive(noTo)).toBeNull()
  })

  it('dedupes by id', () => {
    const state = joined()
    const msg = chat()
    expect(state.receive(msg)).toBe('everyone')
    expect(state.receive({ ...msg })).toBeNull()
    expect(texts(state, 'everyone')).toEqual(['oi'])
    expect(state.tab('everyone')?.unread).toBe(1)
  })

  it('turns a pending send into the echo, in place', () => {
    const state = joined()
    state.receive(chat({ id: 'a', text: 'antes' }))
    const msg = sendOk(state, 'everyone', '  olá  ')
    expect(msg).toEqual({ cid: 'c1', scope: 'everyone', text: 'olá' })
    state.receive(chat({ id: 'b', text: 'no meio' }))

    const pending = state.tab('everyone')?.entries[1]
    expect(pending).toMatchObject({ key: 'c:c1', status: 'pending', own: true, fromName: 'Eu', at: 5 })

    state.receive(chat({ id: 's9', at: 2000, from: SELF, fromName: 'Eu', text: 'olá', cid: 'c1' }))
    expect(state.tab('everyone')?.entries.map((e) => [e.key, e.text, e.status])).toEqual([
      ['m:a', 'antes', 'sent'],
      ['c:c1', 'olá', 'sent'],
      ['m:b', 'no meio', 'sent'],
    ])
    expect(state.tab('everyone')?.entries[1]).toMatchObject({ id: 's9', at: 2000 })
    expect(state.receive(chat({ id: 's9', from: SELF, cid: 'c1' }))).toBeNull()
  })

  it('numbers cids per page', () => {
    const state = joined()
    expect(sendOk(state, 'everyone', 'a').cid).toBe('c1')
    expect(sendOk(state, 'nearby', 'b').cid).toBe('c2')
  })

  it('refuses empty or too long text without adding it', () => {
    const state = joined()
    expect(state.compose('everyone', ' \n ')).toEqual({ ok: false, error: 'empty' })
    expect(state.compose('everyone', 'x'.repeat(501))).toEqual({ ok: false, error: 'too_long' })
    expect(state.tab('everyone')?.entries).toEqual([])
  })

  it('cannot send before welcome or to a missing tab', () => {
    expect(new ChatState().compose('everyone', 'oi')).toBeNull()
    expect(joined().compose('dm:ninguem', 'oi')).toBeNull()
  })

  it('marks a send failed on chatError', () => {
    const state = joined()
    const msg = sendOk(state, 'everyone', 'oi')
    expect(state.fail(msg.cid, 'rate_limited')).toBe(true)
    expect(state.tab('everyone')?.entries[0]).toMatchObject({ status: 'failed', reason: 'rate_limited' })
    expect(state.fail(msg.cid, 'invalid')).toBe(false)
    expect(state.fail('c99', 'invalid')).toBe(false)
  })

  it('fails pending sends on a new welcome', () => {
    const state = joined()
    sendOk(state, 'everyone', 'a')
    sendOk(state, 'nearby', 'b')
    state.welcome(SELF, 'Eu')
    expect(state.tabs().flatMap((t) => t.entries.map((e) => [e.status, e.reason]))).toEqual([
      ['failed', 'disconnected'],
      ['failed', 'disconnected'],
    ])
  })

  it('counts unread only for others outside the open tab', () => {
    const state = joined()
    state.receive(chat())
    state.receive(chat({ from: SELF }))
    sendOk(state, 'everyone', 'meu')
    expect(state.tab('everyone')?.unread).toBe(1)

    state.setOpen(true)
    expect(state.tab('everyone')?.unread).toBe(0)
    state.receive(chat())
    expect(state.tab('everyone')?.unread).toBe(0)
    state.receive(chat({ scope: 'nearby' }))
    state.receive(chat({ scope: 'nearby' }))
    expect(state.tab('nearby')?.unread).toBe(2)
    expect(state.unreadTotal()).toBe(2)

    state.select('nearby')
    expect(state.unreadTotal()).toBe(0)
    state.setOpen(false)
    state.receive(chat({ scope: 'nearby' }))
    expect(state.unreadTotal()).toBe(1)
    expect(state.select('dm:x')).toBe(false)
    expect(state.active).toBe('nearby')
  })

  it('replaces everyone with history, keeping unconfirmed sends last', () => {
    const state = joined()
    state.receive(chat({ id: 'h1', text: 'velha' }))
    state.receive(chat({ scope: 'nearby', text: 'perto' }))
    sendOk(state, 'everyone', 'pendente')
    state.welcome(SELF, 'Eu')
    sendOk(state, 'everyone', 'nova')

    state.history([chat({ id: 'h1', text: 'velha' }), chat({ id: 'h2', text: 'h2' }), chat({ id: 'h2', text: 'h2' }), chat({ scope: 'nearby' })])
    expect(state.tab('everyone')?.entries.map((e) => [e.text, e.status])).toEqual([
      ['velha', 'sent'],
      ['h2', 'sent'],
      ['pendente', 'failed'],
      ['nova', 'pending'],
    ])
    expect(texts(state, 'nearby')).toEqual(['perto'])

    state.history([chat({ id: 'h1', text: 'velha' }), chat({ id: 'h2', text: 'h2' })])
    expect(texts(state, 'everyone')).toEqual(['velha', 'h2', 'pendente', 'nova'])
    expect(state.tab('everyone')?.unread).toBe(1)
  })

  it('marks own history entries as own', () => {
    const state = joined()
    state.history([chat({ from: SELF, fromName: 'Eu' })])
    expect(state.tab('everyone')?.entries[0]?.own).toBe(true)
  })

  it('caps each tab, dropping the oldest', () => {
    const state = joined({ cap: 3 })
    for (let i = 0; i < 5; i++) state.receive(chat({ text: `n${i}` }))
    expect(texts(state, 'everyone')).toEqual(['n2', 'n3', 'n4'])

    const msg = sendOk(state, 'everyone', 'meu')
    for (let i = 0; i < 3; i++) state.receive(chat({ text: `m${i}` }))
    expect(state.fail(msg.cid, 'invalid')).toBe(false)

    state.history(Array.from({ length: 5 }, (_, i) => chat({ text: `h${i}` })))
    expect(texts(state, 'everyone')).toEqual(['h2', 'h3', 'h4'])
  })

  it('keeps the peer name current', () => {
    const state = joined()
    state.openDirect('guest:ana', 'ana?')
    state.receive(chat({ scope: 'direct', to: SELF, fromName: 'Ana' }))
    expect(state.tab('dm:guest:ana')?.peerName).toBe('Ana')
    expect(state.active).toBe('dm:guest:ana')
  })
})

describe('ChatState.closeTab', () => {
  it('closes only direct tabs', () => {
    const state = joined()
    expect(state.closeTab('everyone')).toBe(false)
    expect(state.closeTab('nearby')).toBe(false)
    expect(state.closeTab('dm:guest:x')).toBe(false)
    expect(state.tabs().map((t) => t.key)).toEqual(['everyone', 'nearby'])
  })

  it('selects the tab before the closed active one', () => {
    const state = joined()
    state.openDirect('guest:ana', 'Ana')
    state.openDirect('guest:bia', 'Bia')
    state.select('dm:guest:ana')
    expect(state.closeTab('dm:guest:bia')).toBe(true)
    expect(state.active).toBe('dm:guest:ana')
    expect(state.closeTab('dm:guest:ana')).toBe(true)
    expect(state.active).toBe('nearby')
    expect(state.tabs().map((t) => t.key)).toEqual(['everyone', 'nearby'])
  })

  it('drops its messages and unread count', () => {
    const state = joined()
    state.receive(chat({ scope: 'direct', to: SELF, text: 'um' }))
    expect(state.unreadTotal()).toBe(1)
    state.closeTab('dm:guest:ana')
    expect(state.unreadTotal()).toBe(0)
    expect(state.tab('dm:guest:ana')).toBeUndefined()
  })

  it('reopens on a new message from the peer, empty of the old ones', () => {
    const state = joined()
    state.receive(chat({ scope: 'direct', to: SELF, text: 'um' }))
    state.closeTab('dm:guest:ana')
    expect(state.receive(chat({ scope: 'direct', to: SELF, text: 'dois' }))).toBe('dm:guest:ana')
    expect(texts(state, 'dm:guest:ana')).toEqual(['dois'])
  })

  it('does not reopen for the echo of a send it carried', () => {
    const state = joined()
    state.openDirect('guest:bia', 'Bia')
    const msg = sendOk(state, directKey('guest:bia'), 'oi')
    state.closeTab(directKey('guest:bia'))
    const echo = chat({ from: SELF, fromName: 'Eu', scope: 'direct', to: 'guest:bia', text: 'oi', cid: msg.cid })
    expect(state.receive(echo)).toBeNull()
    expect(state.tab(directKey('guest:bia'))).toBeUndefined()
    expect(state.fail(msg.cid, 'offline')).toBe(false)
    expect(state.receive({ ...echo, id: 'outra' })).toBe(directKey('guest:bia'))
  })
})
