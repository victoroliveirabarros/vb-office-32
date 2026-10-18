import { describe, expect, it } from 'vitest'
import { backoffDelay, closeAction, wsUrl } from './connection'

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
})

describe('closeAction', () => {
  it('stops only when replaced by another tab', () => {
    expect(closeAction(4001)).toBe('replaced')
    expect(closeAction(1001)).toBe('reconnect')
    expect(closeAction(1008)).toBe('reconnect')
    expect(closeAction(1006)).toBe('reconnect')
  })
})
