import { describe, expect, it } from 'vitest'
import { disconnectAction } from './reconnect'

const grant = (expiresAt: number) => ({ url: 'ws://localhost:7880', token: 't', expiresAt })

describe('disconnectAction', () => {
  const now = 1_000_000

  it('never reconnects after our own disconnect, a duplicate identity or a removal', () => {
    for (const kind of ['client', 'duplicate', 'removed'] as const) {
      expect(disconnectAction(kind, grant(now + 600_000), now)).toBe('stop')
    }
  })

  it('retries with a token that still has more than 30s left', () => {
    expect(disconnectAction('other', grant(now + 30_001), now)).toBe('retry')
  })

  it('waits for a new grant otherwise', () => {
    expect(disconnectAction('other', grant(now + 30_000), now)).toBe('wait')
    expect(disconnectAction('other', grant(now - 1), now)).toBe('wait')
    expect(disconnectAction('other', null, now)).toBe('wait')
  })
})
