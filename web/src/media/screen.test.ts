import { describe, expect, it } from 'vitest'
import type { Zone } from '../net/protocol'
import { canShare, permissionsOnlyShrink, screenTarget, sharers, shouldStop, yieldsScreen } from './screen'
import type { Publication, TrackSource } from './subscriptions'

const meeting: Zone = { id: 'sala-1', name: 'Sala 1', kind: 'meeting' }
const booth: Zone = { id: 'cabine', name: 'Cabine', kind: 'private' }
const desk: Zone = { id: 'mesa-01', name: 'Mesa 1', kind: 'desk' }
const nextDesk: Zone = { id: 'mesa-02', name: 'Mesa 2', kind: 'desk' }
const zones = [meeting, booth, desk]

const pub = (identity: string, source: TrackSource = 'screen'): Publication => ({
  identity,
  sid: `${identity}-${source}`,
  source,
  desired: false,
  muted: false,
})

describe('canShare', () => {
  it('allows sharing in any zone, connected, with nobody else sharing', () => {
    for (const zone of zones) {
      expect(canShare(zone, true, false)).toBe(true)
      expect(canShare(zone, false, false)).toBe(false)
      expect(canShare(zone, true, true)).toBe(false)
    }
    expect(canShare(null, true, false)).toBe(false)
    expect(canShare({ id: '' }, true, false)).toBe(false)
  })
})

describe('shouldStop', () => {
  it('keeps a share in its own zone, whatever the kind', () => {
    for (const zone of zones) expect(shouldStop(zone.id, zone)).toBe(false)
  })

  it('stops a share outside every zone', () => {
    expect(shouldStop(desk.id, null)).toBe(true)
    expect(shouldStop(desk.id, { id: '' })).toBe(true)
  })

  it('stops a share on stepping straight into another zone', () => {
    expect(shouldStop(desk.id, nextDesk)).toBe(true)
    expect(shouldStop(meeting.id, booth)).toBe(true)
    expect(shouldStop(null, desk)).toBe(true)
  })
})

describe('sharers', () => {
  it('lists nearby participants publishing a screen', () => {
    const pubs = [pub('a'), pub('b', 'camera'), pub('c'), pub('d')]
    expect(sharers(pubs, new Set(['a', 'b', 'c']))).toEqual(new Set(['a', 'c']))
  })
})

describe('screenTarget', () => {
  const pubs = [pub('c'), pub('b'), pub('a', 'camera'), pub('z')]
  const nearby = new Set(['a', 'b', 'c'])

  it('watches nothing outside a zone', () => {
    expect(screenTarget(pubs, nearby, null, null)).toBeNull()
    expect(screenTarget(pubs, nearby, null, 'b')).toBeNull()
  })

  it('watches a screen in any zone', () => {
    for (const zone of zones) expect(screenTarget(pubs, nearby, zone, null)).toBe('b')
  })

  it('keeps the current screen, otherwise picks the smallest identity in the zone', () => {
    expect(screenTarget(pubs, nearby, meeting, null)).toBe('b')
    expect(screenTarget(pubs, nearby, meeting, 'c')).toBe('c')
    expect(screenTarget(pubs, nearby, meeting, 'z')).toBe('b')
    expect(screenTarget(pubs, new Set(['a']), meeting, 'b')).toBeNull()
  })
})

describe('permissionsOnlyShrink', () => {
  it('holds permissions back away from the share zone while a screen may be on air', () => {
    expect(permissionsOnlyShrink(null, desk.id, true, false)).toBe(true)
    expect(permissionsOnlyShrink(nextDesk, desk.id, true, false)).toBe(true)
    expect(permissionsOnlyShrink(booth, meeting.id, false, true)).toBe(true)
    expect(permissionsOnlyShrink(booth, null, true, false)).toBe(true)
    expect(permissionsOnlyShrink(null, desk.id, false, false)).toBe(false)
    expect(permissionsOnlyShrink(nextDesk, desk.id, false, false)).toBe(false)
  })

  it('lets permissions widen inside the share zone', () => {
    for (const zone of zones) expect(permissionsOnlyShrink(zone, zone.id, true, true)).toBe(false)
  })
})

describe('yieldsScreen', () => {
  it('gives way to a smaller identity sharing in the zone', () => {
    const pubs = [pub('b'), pub('d'), pub('a', 'camera')]
    expect(yieldsScreen(pubs, new Set(['a', 'b', 'd']), 'c')).toBe(true)
    expect(yieldsScreen(pubs, new Set(['a', 'd']), 'c')).toBe(false)
    expect(yieldsScreen(pubs, new Set(['b', 'd']), 'a')).toBe(false)
  })
})
