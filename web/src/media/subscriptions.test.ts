import { describe, expect, it } from 'vitest'
import { subscriptionChanges, videoCandidates } from './subscriptions'
import type { Publication } from './subscriptions'

const pub = (identity: string, kind: 'audio' | 'video', desired = false, muted = false): Publication => ({
  identity,
  sid: `${identity}-${kind}`,
  kind,
  desired,
  muted,
})

describe('videoCandidates', () => {
  it('lists nearby participants with an unmuted camera', () => {
    const pubs = [pub('a', 'video'), pub('b', 'video', false, true), pub('c', 'audio'), pub('d', 'video')]
    expect(videoCandidates(pubs, new Set(['a', 'b', 'c']))).toEqual(new Set(['a']))
  })
})

describe('subscriptionChanges', () => {
  it('subscribes what is wanted and unsubscribes the rest, skipping what already matches', () => {
    const pubs = [
      pub('a', 'audio'),
      pub('a', 'video'),
      pub('b', 'audio', true),
      pub('b', 'video', true),
      pub('c', 'audio', true),
      pub('c', 'video'),
    ]
    const changes = subscriptionChanges(pubs, new Set(['a', 'b']), new Set(['a']))
    expect(changes).toEqual([
      { identity: 'a', sid: 'a-audio', kind: 'audio', subscribe: true },
      { identity: 'a', sid: 'a-video', kind: 'video', subscribe: true },
      { identity: 'b', sid: 'b-video', kind: 'video', subscribe: false },
      { identity: 'c', sid: 'c-audio', kind: 'audio', subscribe: false },
    ])
  })

  it('is empty once the snapshot matches', () => {
    expect(subscriptionChanges([pub('a', 'audio', true), pub('b', 'audio')], new Set(['a']), new Set())).toEqual([])
  })
})
