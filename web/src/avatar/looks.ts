import type { Appearance } from './appearance'
import { formatAppearance } from './appearance'

/** Where composed looks live: the scene's texture manager. */
export type LookStore = {
  add(key: string, a: Appearance): void
  remove(key: string): void
}

export function lookKey(a: Appearance): string {
  return `avatar:${formatAppearance(a)}`
}

/**
 * Composes each look once and shares it among the avatars wearing it; the
 * texture goes when the last of them lets go.
 */
export class LookCache {
  private readonly refs = new Map<string, number>()

  constructor(private readonly store: LookStore) {}

  acquire(a: Appearance): string {
    const key = lookKey(a)
    const n = this.refs.get(key) ?? 0
    if (n === 0) this.store.add(key, a)
    this.refs.set(key, n + 1)
    return key
  }

  release(key: string): void {
    const n = this.refs.get(key)
    if (n === undefined) return
    if (n > 1) {
      this.refs.set(key, n - 1)
      return
    }
    this.refs.delete(key)
    this.store.remove(key)
  }

  get size(): number {
    return this.refs.size
  }
}
