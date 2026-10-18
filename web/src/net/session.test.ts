import { describe, expect, it } from 'vitest'
import { fetchSession, logout, parseSession, sessionAlive } from './session'
import type { Fetch } from './session'

type Call = { input: string; init?: RequestInit }

function fakeFetch(status: number, body: string): { fetch: Fetch; calls: Call[] } {
  const calls: Call[] = []
  return {
    calls,
    fetch: async (input, init) => {
      calls.push({ input, init })
      return new Response(status === 204 ? null : body, { status })
    },
  }
}

const failingFetch: Fetch = () => Promise.reject(new TypeError('network down'))

describe('parseSession', () => {
  it('accepts an oidc session', () => {
    expect(parseSession(200, { id: 'oidc:1', name: 'Zé', auth: 'oidc' })).toEqual({
      status: 'authenticated',
      id: 'oidc:1',
      name: 'Zé',
    })
  })

  it('maps 401 to the login screen of each mode', () => {
    expect(parseSession(401, { auth: 'oidc' })).toEqual({ status: 'anonymous', auth: 'oidc' })
    expect(parseSession(401, { auth: 'guest' })).toEqual({ status: 'anonymous', auth: 'guest' })
  })

  it('rejects anything else', () => {
    expect(parseSession(200, { auth: 'oidc' })).toBeNull()
    expect(parseSession(200, { id: 'guest:a', name: 'a', auth: 'guest' })).toBeNull()
    expect(parseSession(200, { id: 1, name: 'a', auth: 'oidc' })).toBeNull()
    expect(parseSession(401, { auth: 'saml' })).toBeNull()
    expect(parseSession(500, { auth: 'oidc' })).toBeNull()
    expect(parseSession(401, null)).toBeNull()
    expect(parseSession(401, ['oidc'])).toBeNull()
  })
})

describe('fetchSession', () => {
  it('reads /api/session without caching', async () => {
    const f = fakeFetch(200, '{"id":"oidc:1","name":"Ana","auth":"oidc"}')
    await expect(fetchSession(f.fetch)).resolves.toEqual({ status: 'authenticated', id: 'oidc:1', name: 'Ana' })
    expect(f.calls).toEqual([{ input: '/api/session', init: { credentials: 'same-origin', cache: 'no-store' } }])
  })

  it('returns null for a non-JSON body', async () => {
    await expect(fetchSession(fakeFetch(502, '<html>bad gateway</html>').fetch)).resolves.toBeNull()
  })
})

describe('logout', () => {
  it('posts to /auth/logout', async () => {
    const f = fakeFetch(204, '')
    await logout(f.fetch)
    expect(f.calls).toEqual([{ input: '/auth/logout', init: { method: 'POST', credentials: 'same-origin' } }])
  })
})

describe('sessionAlive', () => {
  it('is false only on a definite 401', async () => {
    await expect(sessionAlive(fakeFetch(401, '{"auth":"oidc"}').fetch)).resolves.toBe(false)
    await expect(sessionAlive(fakeFetch(200, '{"id":"oidc:1","name":"Ana","auth":"oidc"}').fetch)).resolves.toBe(true)
    await expect(sessionAlive(fakeFetch(502, 'bad gateway').fetch)).resolves.toBe(true)
    await expect(sessionAlive(failingFetch)).resolves.toBe(true)
  })
})
