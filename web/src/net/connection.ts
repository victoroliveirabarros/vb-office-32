import { CLOSE_EXPIRED, CLOSE_REPLACED, encode, parseServerMessage } from './protocol'
import type { ClientMessage, ServerMessage } from './protocol'

export type ConnectionStatus = 'connecting' | 'open' | 'reconnecting' | 'replaced' | 'expired'

type Listener<T> = (value: T) => void

const BACKOFF_BASE_MS = 500
const BACKOFF_MAX_MS = 10_000

export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** attempt)
  return ceiling / 2 + random() * (ceiling / 2)
}

export type CloseAction = 'replaced' | 'expired' | 'reconnect'

export function closeAction(code: number): CloseAction {
  switch (code) {
    case CLOSE_REPLACED:
      return 'replaced'
    case CLOSE_EXPIRED:
      return 'expired'
    default:
      return 'reconnect'
  }
}

/** av is the saved look in compact form, applied before the welcome. */
export function wsUrl(name?: string, av?: string | null, loc: Pick<Location, 'protocol' | 'host'> = location): string {
  const scheme = loc.protocol === 'https:' ? 'wss' : 'ws'
  const params: string[] = []
  if (name !== undefined) params.push(`name=${encodeURIComponent(name)}`)
  if (av) params.push(`av=${encodeURIComponent(av)}`)
  const query = params.length === 0 ? '' : `?${params.join('&')}`
  return `${scheme}://${loc.host}/ws${query}`
}

// CheckAuth resolves false only when the session is definitely gone.
export type CheckAuth = () => Promise<boolean>

export class Connection {
  private socket: WebSocket | null = null
  private attempt = 0
  private retryTimer: number | undefined
  private readonly messageListeners = new Set<Listener<ServerMessage>>()
  private readonly statusListeners = new Set<Listener<ConnectionStatus>>()

  // A refused upgrade (401) reaches the browser as a bare 1006, so a socket
  // that closes without opening asks checkAuth before retrying. A url
  // function is asked again on every attempt, so a reconnect carries what
  // changed since, like the saved look.
  constructor(
    private readonly url: string | (() => string),
    private readonly checkAuth?: CheckAuth,
  ) {}

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

    const socket = new WebSocket(typeof this.url === 'string' ? this.url : this.url())
    this.socket = socket
    let opened = false

    socket.onopen = () => {
      opened = true
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
      const action = closeAction(event.code)
      if (action !== 'reconnect') {
        this.emitStatus(action)
        return
      }
      if (!opened && this.checkAuth) {
        void this.checkAuth().then(
          (alive) => (alive ? this.scheduleReconnect() : this.emitStatus('expired')),
          () => this.scheduleReconnect(),
        )
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
    this.retryTimer = setTimeout(() => this.connect(), delay)
  }

  private emitStatus(status: ConnectionStatus): void {
    this.statusListeners.forEach((fn) => fn(status))
  }
}
