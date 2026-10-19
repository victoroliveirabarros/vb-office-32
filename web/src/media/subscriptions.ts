export type TrackSource = 'microphone' | 'camera' | 'screen'

export type Publication = {
  identity: string
  sid: string
  source: TrackSource
  desired: boolean
  muted: boolean
}

export type SubscriptionChange = { identity: string; sid: string; source: TrackSource; subscribe: boolean }

// Wanted holds, per source, the participants to subscribe to.
export type Wanted = Record<TrackSource, ReadonlySet<string>>

// videoCandidates are the nearby participants with a camera turned on.
export function videoCandidates(pubs: readonly Publication[], nearby: ReadonlySet<string>): Set<string> {
  const ids = new Set<string>()
  for (const pub of pubs) {
    if (pub.source === 'camera' && !pub.muted && nearby.has(pub.identity)) ids.add(pub.identity)
  }
  return ids
}

export function subscriptionChanges(pubs: readonly Publication[], wanted: Wanted): SubscriptionChange[] {
  const changes: SubscriptionChange[] = []
  for (const pub of pubs) {
    const want = wanted[pub.source].has(pub.identity)
    if (want !== pub.desired) changes.push({ identity: pub.identity, sid: pub.sid, source: pub.source, subscribe: want })
  }
  return changes
}
