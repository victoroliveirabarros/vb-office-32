import { describe, expect, it } from 'vitest'
import { peopleSummary, placeText } from './people'
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
})
