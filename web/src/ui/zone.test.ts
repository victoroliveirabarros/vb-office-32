import { describe, expect, it } from 'vitest'
import { zoneAnnouncement, zoneText } from './zone'

const sala = { id: 'sala-1', name: 'Sala 1', kind: 'meeting' } as const
const cabine = { id: 'cabine', name: 'Cabine', kind: 'private' } as const

describe('zone view', () => {
  it('names the room and its kind', () => {
    expect(zoneText(sala)).toBe('Sala 1 — reunião')
    expect(zoneText(cabine)).toBe('Cabine — privada')
    expect(zoneText({ id: 'ringue', name: 'Ringue de box', kind: 'private' })).toBe('Ringue de box — privada')
  })

  it('does not repeat a kind the name already says', () => {
    expect(zoneText({ id: 'reuniao', name: 'Sala de Reunião', kind: 'meeting' })).toBe('Sala de Reunião')
    expect(zoneText({ id: 'privada', name: 'Sala privada', kind: 'private' })).toBe('Sala privada')
    expect(zoneText({ id: 'privada', name: 'Sala privada', kind: 'meeting' })).toBe('Sala privada — reunião')
  })

  it('announces entering, leaving and switching rooms only', () => {
    expect(zoneAnnouncement(null, null)).toBeNull()
    expect(zoneAnnouncement(sala, sala)).toBeNull()
    expect(zoneAnnouncement(null, sala)).toMatch(/^Você entrou em Sala 1 — reunião\. /)
    expect(zoneAnnouncement(sala, null)).toBe('Você saiu de Sala 1.')
    expect(zoneAnnouncement(sala, cabine)).toMatch(/^Você entrou em Cabine — privada\. /)
  })
})
