import type { Media } from '../net/protocol'

export type DisconnectKind = 'client' | 'duplicate' | 'removed' | 'other'

export type DisconnectAction = 'stop' | 'retry' | 'wait'

// A token this close to expiring is not worth a connect attempt.
export const TOKEN_MARGIN_MS = 30_000

// The server removes whoever stays off the game socket for a while; the grant
// it sends when the socket is back lets the player in again.
export function disconnectAction(kind: DisconnectKind, grant: Media | null, now: number): DisconnectAction {
  if (kind === 'client' || kind === 'duplicate') return 'stop'
  if (kind === 'removed') return 'wait'
  return grant && grant.expiresAt > now + TOKEN_MARGIN_MS ? 'retry' : 'wait'
}
