import type { Media } from '../net/protocol'

export type DisconnectKind = 'client' | 'duplicate' | 'removed' | 'other'

export type DisconnectAction = 'stop' | 'retry' | 'wait'

// A token this close to expiring is not worth a connect attempt.
export const TOKEN_MARGIN_MS = 30_000

export function disconnectAction(kind: DisconnectKind, grant: Media | null, now: number): DisconnectAction {
  if (kind !== 'other') return 'stop'
  return grant && grant.expiresAt > now + TOKEN_MARGIN_MS ? 'retry' : 'wait'
}
