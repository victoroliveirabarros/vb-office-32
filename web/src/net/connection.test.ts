import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { backoffDelay, closeAction, Connection, wsUrl } from './connection'
import type { ConnectionStatus } from './connection'

describe('backoffDelay', () => {
  it('grows exponentially with jitter and caps at 10s', () => {
    expect(backoffDelay(0, () => 0)).toBe(250)
    expect(backoffDelay(0, () => 1)).toBe(500)
    expect(backoffDelay(3, () => 1)).toBe(4000)
    expect(backoffDelay(10, () => 1)).toBe(10_000)
    expect(backoffDelay(10, () => 0)).toBe(5000)
  })
})

describe('wsUrl', () => {
  it('uses wss under https and encodes the name', () => {
    expect(wsUrl('Ana Maria', { protocol: 'https:', host: 'office.example' })).toBe('wss://office.example/ws?name=Ana%20Maria')
    expect(wsUrl('bob', { protocol: 'http:', host: 'localhost:5173' })).toBe('ws://localhost:5173/ws?name=bob')
  })

  it('omits the name when the session identifies the user', () => {
    expect(wsUrl(undefined, { protocol: 'https:', host: 'office.example' })).toBe('wss://office.example/ws')
  })
})

describe('closeAction', () => {
  it('stops when replaced or expired and reconnects otherwise', () => {
    expect(closeAction(4001)).toBe('replaced')
    expect(closeAction(4002)).toBe('expired')
    expect(closeAction(1001)).toBe('reconnect')
    expect(closeAction(1008)).toBe('reconnect')
    expect(closeAction(1006)).toBe('reconnect')
  })
})

class FakeSocket {
  static readonly OPEN = 1
  static readonly instances: FakeSocket[] = []
  readyState = 0
  onopen: (() => void) | null = null
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null
  onclose: ((event: { code: number }) => void) | null = null

  constructor(readonly url: string) {
    FakeSocket.instances.push(this)
  }

  open(): void {
    this.readyState = FakeSocket.OPEN
    this.onopen?.()
  }

  close(code: number): void {
    this.readyState = 3
    this.onclose?.({ code })
  }
}

describe('Connection', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', FakeSocket)
    FakeSocket.instances.length = 0
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  function connect(checkAuth?: () => Promise<boolean>): { statuses: ConnectionStatus[]; latest: () => FakeSocket } {
    const conn = new Connection('ws://office.example/ws', checkAuth)
    const statuses: ConnectionStatus[] = []
    conn.onStatus((s) => statuses.push(s))
    conn.connect()
    return {
      statuses,
      latest: () => {
        const s = FakeSocket.instances.at(-1)
        if (!s) throw new Error('no socket')
        return s
      },
    }
  }

  it('expires when a refused upgrade turns out to be a lost session', async () => {
    const checkAuth = vi.fn(() => Promise.resolve(false))
    const { statuses, latest } = connect(checkAuth)
    latest().close(1006)
    await vi.runAllTimersAsync()

    expect(checkAuth).toHaveBeenCalledOnce()
    expect(statuses).toEqual(['connecting', 'expired'])
    expect(FakeSocket.instances).toHaveLength(1)
  })

  it('keeps retrying when the session is still valid', async () => {
    const checkAuth = vi.fn(() => Promise.resolve(true))
    const { statuses, latest } = connect(checkAuth)
    latest().close(1006)
    await vi.advanceTimersByTimeAsync(600)

    expect(checkAuth).toHaveBeenCalledOnce()
    expect(statuses).toEqual(['connecting', 'reconnecting'])
    expect(FakeSocket.instances).toHaveLength(2)
  })

  it('reconnects without asking after an established connection drops', async () => {
    const checkAuth = vi.fn(() => Promise.resolve(false))
    const { statuses, latest } = connect(checkAuth)
    latest().open()
    latest().close(1006)
    await vi.advanceTimersByTimeAsync(600)

    expect(checkAuth).not.toHaveBeenCalled()
    expect(statuses).toEqual(['connecting', 'open', 'reconnecting'])
    expect(FakeSocket.instances).toHaveLength(2)
  })

  it('stops on 4002 without checking', async () => {
    const checkAuth = vi.fn(() => Promise.resolve(true))
    const { statuses, latest } = connect(checkAuth)
    latest().open()
    latest().close(4002)
    await vi.runAllTimersAsync()

    expect(checkAuth).not.toHaveBeenCalled()
    expect(statuses).toEqual(['connecting', 'open', 'expired'])
    expect(FakeSocket.instances).toHaveLength(1)
  })

  it('retries when checkAuth fails', async () => {
    const { statuses, latest } = connect(() => Promise.reject(new Error('boom')))
    latest().close(1006)
    await vi.advanceTimersByTimeAsync(600)

    expect(statuses).toEqual(['connecting', 'reconnecting'])
    expect(FakeSocket.instances).toHaveLength(2)
  })

  it('reconnects in guest mode without checkAuth', async () => {
    const { statuses, latest } = connect()
    latest().close(1006)
    await vi.advanceTimersByTimeAsync(600)

    expect(statuses).toEqual(['connecting', 'reconnecting'])
    expect(FakeSocket.instances).toHaveLength(2)
  })
})
