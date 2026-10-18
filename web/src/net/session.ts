import { isRecord, isString } from '../guards'

export type AuthMode = 'oidc' | 'guest'

export type Session =
  | { status: 'authenticated'; id: string; name: string }
  | { status: 'anonymous'; auth: AuthMode }

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>

const defaultFetch: Fetch = (input, init) => fetch(input, init)

export function parseSession(status: number, body: unknown): Session | null {
  if (!isRecord(body) || (body.auth !== 'oidc' && body.auth !== 'guest')) return null
  if (status === 200 && body.auth === 'oidc' && isString(body.id) && isString(body.name)) {
    return { status: 'authenticated', id: body.id, name: body.name }
  }
  if (status === 401) return { status: 'anonymous', auth: body.auth }
  return null
}

export async function fetchSession(fetchFn: Fetch = defaultFetch): Promise<Session | null> {
  const res = await fetchFn('/api/session', { credentials: 'same-origin', cache: 'no-store' })
  let body: unknown
  try {
    body = await res.json()
  } catch {
    return null
  }
  return parseSession(res.status, body)
}

export async function logout(fetchFn: Fetch = defaultFetch): Promise<void> {
  await fetchFn('/auth/logout', { method: 'POST', credentials: 'same-origin' })
}

// sessionAlive is the Connection's checkAuth in oidc mode: only a definite
// 401 ends the session; network errors keep the reconnect loop going.
export async function sessionAlive(fetchFn: Fetch = defaultFetch): Promise<boolean> {
  try {
    const session = await fetchSession(fetchFn)
    return session?.status !== 'anonymous'
  } catch {
    return true
  }
}
