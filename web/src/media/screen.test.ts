import { describe, expect, it } from 'vitest'
import type { Zone } from '../net/protocol'
import { canShare, screenTarget, sharers, shouldStop } from './screen'
import type { Publication, TrackSource } from './subscriptions'

const meeting: Zone = { id: 'sala-1', name: 'Sala 1', kind: 'meeting' }
const booth: Zone = { id: 'cabine', name: 'Cabine', kind: 'private' }

const pub = (identity: string, source: TrackSource = 'screen'): Publication => ({
  identity,
  sid: `${identity}-${source}`,
  source,
  desired: false,
  muted: false,
})

describe('canShare', () => {
  it('allows sharing only in a meeting room, connected, with nobody else sharing', () => {
    expect(canShare(meeting, true, false)).toBe(true)
    expect(canShare(meeting, false, false)).toBe(false)
    expect(canShare(meeting, true, true)).toBe(false)
    expect(canShare(booth, true, false)).toBe(false)
    expect(canShare(null, true, false)).toBe(false)
  })
})

describe('shouldStop', () => {
  it('stops a share outside meeting rooms', () => {
    expect(shouldStop(meeting)).toBe(false)
    expect(shouldStop(booth)).toBe(true)
    expect(shouldStop(null)).toBe(true)
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

  it('watches nothing outside a meeting room', () => {
    expect(screenTarget(pubs, nearby, null, null)).toBeNull()
    expect(screenTarget(pubs, nearby, booth, 'b')).toBeNull()
  })

  it('keeps the current screen, otherwise picks the smallest identity in the room', () => {
    expect(screenTarget(pubs, nearby, meeting, null)).toBe('b')
    expect(screenTarget(pubs, nearby, meeting, 'c')).toBe('c')
    expect(screenTarget(pubs, nearby, meeting, 'z')).toBe('b')
    expect(screenTarget(pubs, new Set(['a']), meeting, 'b')).toBeNull()
  })
})
