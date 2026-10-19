// AllowedSubscribers remembers the subscriber list last handed to LiveKit,
// so a nearby that does not change it sends nothing.
export class AllowedSubscribers {
  private sent: string | null = null

  // update returns the sorted ids to send, or null when they match the last
  // ones sent.
  update(ids: Iterable<string>): string[] | null {
    const sorted = [...new Set(ids)].sort()
    const key = sorted.join('\n')
    if (key === this.sent) return null
    this.sent = key
    return sorted
  }

  // reset forgets what was sent, so the next update always sends.
  reset(): void {
    this.sent = null
  }
}
