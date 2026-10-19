import type { Media } from '../net/protocol'

export type DisconnectKind = 'client' | 'duplicate' | 'removed' | 'other'

export type DisconnectAction = 'stop' | 'retry' | 'wait'

// A token this close to expiring is not worth a connect attempt.
export const TOKEN_MARGIN_MS = 30_000

// The server only removes whoever stayed off the game socket for 30s, so a
// grant younger than this means the removal raced the socket coming back.
export const FRESH_GRANT_MS = 10_000

// The server removes whoever stays off the game socket for a while; the grant
// it sends when the socket is back lets the player in again.
export function disconnectAction(
  kind: DisconnectKind,
  grant: Media | null,
  now: number,
  grantAt = -Infinity,
): DisconnectAction {
  if (kind === 'client' || kind === 'duplicate') return 'stop'
  const usable = grant !== null && grant.expiresAt > now + TOKEN_MARGIN_MS
  if (kind === 'removed') return usable && now - grantAt < FRESH_GRANT_MS ? 'retry' : 'wait'
  return usable ? 'retry' : 'wait'
}
