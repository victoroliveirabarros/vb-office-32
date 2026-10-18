export type TrackKind = 'audio' | 'video'

export type Publication = {
  identity: string
  sid: string
  kind: TrackKind
  desired: boolean
  muted: boolean
}

export type SubscriptionChange = { identity: string; sid: string; kind: TrackKind; subscribe: boolean }

// videoCandidates are the nearby participants with a camera turned on.
export function videoCandidates(pubs: readonly Publication[], nearby: ReadonlySet<string>): Set<string> {
  const ids = new Set<string>()
  for (const pub of pubs) {
    if (pub.kind === 'video' && !pub.muted && nearby.has(pub.identity)) ids.add(pub.identity)
  }
  return ids
}

export function subscriptionChanges(
  pubs: readonly Publication[],
  audio: ReadonlySet<string>,
  video: ReadonlySet<string>,
): SubscriptionChange[] {
  const changes: SubscriptionChange[] = []
  for (const pub of pubs) {
    const want = (pub.kind === 'audio' ? audio : video).has(pub.identity)
    if (want !== pub.desired) changes.push({ identity: pub.identity, sid: pub.sid, kind: pub.kind, subscribe: want })
  }
  return changes
}
