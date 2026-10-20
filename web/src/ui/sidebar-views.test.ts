import { describe, expect, it } from 'vitest'
import { Desks } from '../game/desks'
import { inviteAction, peopleSummary, placeText } from './people'
import { whoText } from './rooms'

describe('panel texts', () => {
  it('sums up the people list and its search', () => {
    expect(peopleSummary(1, 1, '')).toBe('Só você no escritório')
    expect(peopleSummary(12, 12, '')).toBe('12 pessoas no escritório')
    expect(peopleSummary(12, 3, 'an')).toBe('3 de 12 no escritório')
    expect(peopleSummary(12, 0, 'zz')).toBe('Ninguém com esse nome.')
  })

  it('says where someone is', () => {
    expect(placeText({ room: { id: 'r', name: 'Sala de reunião', kind: 'meeting' }, area: null })).toBe('Sala de reunião')
    expect(placeText({ room: null, area: { id: 'copa', name: 'Copa' } })).toBe('Copa')
    expect(placeText({ room: null, area: null })).toBe('Escritório aberto')
  })

  it('names who is in a room, a few at most', () => {
    expect(whoText([])).toBe('Ninguém aqui agora')
    expect(whoText(['Ana'])).toBe('Ana')
    expect(whoText(['Ana', 'Bia', 'Cris'])).toBe('Ana, Bia e Cris')
    expect(whoText(['A', 'B', 'C', 'D', 'E', 'F'])).toBe('A, B, C, D e mais 2')
  })

  it('offers the invite to our desk only when we own one, and only for others', () => {
    const desks = new Desks()
    desks.handle({ t: 'welcome', d: { selfId: 'guest:ana', mapId: 'office', tickRate: 20, stepMs: 150, players: [] } })
    const eve = { id: 'guest:eve', self: false, label: 'eve' }
    expect(inviteAction(eve, desks)).toBeNull()

    desks.handle({ t: 'desks', d: { desks: [{ id: 'mesa-01', ownerId: 'guest:ana', ownerName: 'ana', online: true, locked: true }] } })
    expect(inviteAction({ id: 'guest:ana', self: true, label: 'ana' }, desks)).toBeNull()
    expect(inviteAction(eve, desks)).toEqual({ invite: true, icon: 'user-plus', text: 'Convidar para minha mesa', label: 'Convidar eve para minha mesa' })

    desks.handle({ t: 'deskGuests', d: { desk: 'mesa-01', guests: [{ id: 'guest:eve', name: 'eve', online: true }] } })
    expect(inviteAction(eve, desks)).toEqual({ invite: false, icon: 'user-minus', text: 'Remover convite', label: 'Remover convite de eve' })
  })
})
