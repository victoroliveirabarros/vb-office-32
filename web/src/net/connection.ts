import { CLOSE_REPLACED, encode, parseServerMessage } from './protocol'
import type { ClientMessage, ServerMessage } from './protocol'

export type ConnectionStatus = 'connecting' | 'open' | 'reconnecting' | 'replaced'

type Listener<T> = (value: T) => void

const BACKOFF_BASE_MS = 500
const BACKOFF_MAX_MS = 10_000

export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** attempt)
  return ceiling / 2 + random() * (ceiling / 2)
}

export type CloseAction = 'replaced' | 'reconnect'

export function closeAction(code: number): CloseAction {
  return code === CLOSE_REPLACED ? 'replaced' : 'reconnect'
}

export function wsUrl(name: string, loc: Pick<Location, 'protocol' | 'host'> = location): string {
  const scheme = loc.protocol === 'https:' ? 'wss' : 'ws'
  return `${scheme}://${loc.host}/ws?name=${encodeURIComponent(name)}`
}

export class Connection {
  private socket: WebSocket | null = null
  private attempt = 0
  private retryTimer: number | undefined
  private readonly messageListeners = new Set<Listener<ServerMessage>>()
  private readonly statusListeners = new Set<Listener<ConnectionStatus>>()

  constructor(private readonly url: string) {}

  onMessage(fn: Listener<ServerMessage>): () => void {
    this.messageListeners.add(fn)
    return () => this.messageListeners.delete(fn)
  }

  onStatus(fn: Listener<ConnectionStatus>): () => void {
    this.statusListeners.add(fn)
    return () => this.statusListeners.delete(fn)
  }

  get isOpen(): boolean {
    return this.socket?.readyState === WebSocket.OPEN
  }

  connect(): void {
    clearTimeout(this.retryTimer)
    if (this.attempt === 0) this.emitStatus('connecting')

    const socket = new WebSocket(this.url)
    this.socket = socket

    socket.onopen = () => {
      this.attempt = 0
      this.emitStatus('open')
    }
    socket.onmessage = (event: MessageEvent<unknown>) => {
      if (typeof event.data !== 'string') return
      const msg = parseServerMessage(event.data)
      if (msg) this.messageListeners.forEach((fn) => fn(msg))
    }
    socket.onclose = (event) => {
      if (this.socket !== socket) return
      this.socket = null
      if (closeAction(event.code) === 'replaced') {
        this.emitStatus('replaced')
        return
      }
      this.scheduleReconnect()
    }
  }

  send(msg: ClientMessage): boolean {
    if (!this.socket || !this.isOpen) return false
    this.socket.send(encode(msg))
    return true
  }

  private scheduleReconnect(): void {
    this.emitStatus('reconnecting')
    const delay = backoffDelay(this.attempt)
    this.attempt++
    this.retryTimer = window.setTimeout(() => this.connect(), delay)
  }

  private emitStatus(status: ConnectionStatus): void {
    this.statusListeners.forEach((fn) => fn(status))
  }
}
