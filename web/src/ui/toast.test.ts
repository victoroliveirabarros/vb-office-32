import { describe, expect, it } from 'vitest'
import { inviteText } from './toast'

describe('invite toast', () => {
  it('names the owner who invited us or took the invite back', () => {
    expect(inviteText({ ownerName: 'Ana Souza', invited: true })).toBe('Ana Souza convidou você para a mesa')
    expect(inviteText({ ownerName: 'Ana Souza', invited: false })).toBe('Convite para a mesa de Ana Souza removido')
  })
})
