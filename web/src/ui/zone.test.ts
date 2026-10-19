import { describe, expect, it } from 'vitest'
import { zoneAnnouncement, zoneText } from './zone'

const sala = { id: 'sala-1', name: 'Sala 1', kind: 'meeting' } as const
const cabine = { id: 'cabine', name: 'Cabine', kind: 'private' } as const

describe('zone view', () => {
  it('names the room and its kind', () => {
    expect(zoneText(sala)).toBe('Sala 1 — reunião')
    expect(zoneText(cabine)).toBe('Cabine — privada')
  })

  it('announces entering, leaving and switching rooms only', () => {
    expect(zoneAnnouncement(null, null)).toBeNull()
    expect(zoneAnnouncement(sala, sala)).toBeNull()
    expect(zoneAnnouncement(null, sala)).toMatch(/^Você entrou em Sala 1 — reunião\. /)
    expect(zoneAnnouncement(sala, null)).toBe('Você saiu de Sala 1.')
    expect(zoneAnnouncement(sala, cabine)).toMatch(/^Você entrou em Cabine — privada\. /)
  })
})
