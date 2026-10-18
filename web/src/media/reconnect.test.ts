import { describe, expect, it } from 'vitest'
import { disconnectAction } from './reconnect'

const grant = (expiresAt: number) => ({ url: 'ws://localhost:7880', token: 't', expiresAt })

describe('disconnectAction', () => {
  const now = 1_000_000

  it('never reconnects after our own disconnect or a duplicate identity', () => {
    for (const kind of ['client', 'duplicate'] as const) {
      expect(disconnectAction(kind, grant(now + 600_000), now)).toBe('stop')
    }
  })

  it('waits for a new grant after a removal, even with a valid token', () => {
    expect(disconnectAction('removed', grant(now + 600_000), now)).toBe('wait')
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
