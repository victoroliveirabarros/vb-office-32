import { describe, expect, it } from 'vitest'
import { subscriptionChanges, videoCandidates } from './subscriptions'
import type { Publication, TrackSource } from './subscriptions'

const pub = (identity: string, source: TrackSource, desired = false, muted = false): Publication => ({
  identity,
  sid: `${identity}-${source}`,
  source,
  desired,
  muted,
})

const none = new Set<string>()

describe('videoCandidates', () => {
  it('lists nearby participants with an unmuted camera', () => {
    const pubs = [pub('a', 'camera'), pub('b', 'camera', false, true), pub('c', 'microphone'), pub('d', 'camera'), pub('e', 'screen')]
    expect(videoCandidates(pubs, new Set(['a', 'b', 'c', 'e']))).toEqual(new Set(['a']))
  })
})

describe('subscriptionChanges', () => {
  it('subscribes what is wanted and unsubscribes the rest, skipping what already matches', () => {
    const pubs = [
      pub('a', 'microphone'),
      pub('a', 'camera'),
      pub('a', 'screen'),
      pub('b', 'microphone', true),
      pub('b', 'camera', true),
      pub('b', 'screen', true),
      pub('c', 'microphone', true),
      pub('c', 'camera'),
    ]
    const changes = subscriptionChanges(pubs, { microphone: new Set(['a', 'b']), camera: new Set(['a']), screen: new Set(['a']) })
    expect(changes).toEqual([
      { identity: 'a', sid: 'a-microphone', source: 'microphone', subscribe: true },
      { identity: 'a', sid: 'a-camera', source: 'camera', subscribe: true },
      { identity: 'a', sid: 'a-screen', source: 'screen', subscribe: true },
      { identity: 'b', sid: 'b-camera', source: 'camera', subscribe: false },
      { identity: 'b', sid: 'b-screen', source: 'screen', subscribe: false },
      { identity: 'c', sid: 'c-microphone', source: 'microphone', subscribe: false },
    ])
  })

  it('is empty once the snapshot matches', () => {
    const pubs = [pub('a', 'microphone', true), pub('b', 'microphone')]
    expect(subscriptionChanges(pubs, { microphone: new Set(['a']), camera: none, screen: none })).toEqual([])
  })
})
