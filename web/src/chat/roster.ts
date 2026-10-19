import type { ServerMessage } from '../net/protocol'

export type Person = { id: string; name: string; self: boolean; nearby: boolean }

const collator = new Intl.Collator('pt-BR', { sensitivity: 'base', numeric: true })

// Roster tracks who is in the space and who is in earshot, from the game
// socket alone, so chat works with or without media.
export class Roster {
  private selfId: string | null = null
  private readonly names = new Map<string, string>()
  private nearbyIds: ReadonlySet<string> = new Set()

  get self(): string | null {
    return this.selfId
  }

  /** Applies msg and reports whether the roster changed. */
  handle(msg: ServerMessage): boolean {
    switch (msg.t) {
      case 'welcome':
        this.selfId = msg.d.selfId
        this.names.clear()
        for (const p of msg.d.players) this.names.set(p.id, p.name)
        this.nearbyIds = new Set()
        return true
      case 'joined':
        this.names.set(msg.d.id, msg.d.name)
        return true
      case 'left': {
        if (!this.names.delete(msg.d.id)) return false
        if (this.nearbyIds.has(msg.d.id)) this.nearbyIds = new Set([...this.nearbyIds].filter((id) => id !== msg.d.id))
        return true
      }
      case 'nearby':
        this.nearbyIds = new Set(msg.d.ids.filter((id) => id !== this.selfId))
        return true
      default:
        return false
    }
  }

  online(id: string): boolean {
    return this.names.has(id)
  }

  name(id: string): string | undefined {
    return this.names.get(id)
  }

  /** Others in earshot, online only. */
  nearby(): string[] {
    return [...this.nearbyIds].filter((id) => this.names.has(id))
  }

  /** Everyone online, self first, then by name in pt-BR order. */
  list(): Person[] {
    return [...this.names]
      .map(([id, name]) => ({ id, name, self: id === this.selfId, nearby: this.nearbyIds.has(id) }))
      .sort((a, b) => Number(b.self) - Number(a.self) || collator.compare(a.name, b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  }
}
