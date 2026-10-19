// AllowedSubscribers remembers the subscriber list last handed to LiveKit,
// so a nearby that does not change it sends nothing.
export class AllowedSubscribers {
  private sent: readonly string[] | null = null

  // update returns the sorted ids to send, or null when they match the last
  // ones sent.
  update(ids: Iterable<string>): string[] | null {
    const sorted = [...new Set(ids)].sort()
    if (this.sent !== null && sorted.length === this.sent.length && sorted.every((id, i) => id === this.sent?.[i])) return null
    this.sent = sorted
    return sorted
  }

  // restrict is update that may only take ids away: it keeps those of ids
  // already sent, and none after a reset.
  restrict(ids: Iterable<string>): string[] | null {
    const sent = new Set(this.sent ?? [])
    return this.update([...ids].filter((id) => sent.has(id)))
  }

  // reset forgets what was sent, so the next update always sends.
  reset(): void {
    this.sent = null
  }
}
