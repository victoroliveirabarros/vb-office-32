import { describe, expect, it } from 'vitest'
import { isDevHost } from '../vite.config'

describe('isDevHost', () => {
  it('accepts the loopback names the dev server is opened with', () => {
    for (const host of ['localhost', 'localhost:5173', '127.0.0.1:5173']) expect(isDevHost(host)).toBe(true)
  })

  it('refuses other names, as a DNS-rebound page would send', () => {
    for (const host of [undefined, '', 'evil.com:5173', 'localhost.evil.com:5173', 'evil.localhost:5173', '127.0.0.1.nip.io', 'a b']) {
      expect(isDevHost(host)).toBe(false)
    }
  })
})
