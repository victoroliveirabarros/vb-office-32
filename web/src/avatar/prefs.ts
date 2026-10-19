import { formatAppearance, parseAppearance } from './appearance'
import type { Appearance } from './appearance'

const AVATAR_KEY = 'vb-office-32.avatar'

export type AvatarPrefs = {
  /** The saved look, or null when none or one this catalog does not have. */
  load(): Appearance | null
  save(a: Appearance): void
}

// Storage may be missing or throw on access (private mode, blocked site
// data); the look then lasts as long as the server remembers it.
export function avatarPrefs(storage: () => Storage = () => localStorage): AvatarPrefs {
  return {
    load() {
      try {
        const saved = storage().getItem(AVATAR_KEY)
        return saved === null ? null : parseAppearance(saved)
      } catch {
        return null
      }
    },
    save(a) {
      try {
        storage().setItem(AVATAR_KEY, formatAppearance(a))
      } catch {
        // see above
      }
    },
  }
}
