import type { Chat, ChatErrorReason, ChatScope, ChatSend } from '../net/protocol'
import { clean } from './clean'
import type { CleanError } from './clean'

export type TabKey = 'everyone' | 'nearby' | `dm:${string}`

export type FailReason = ChatErrorReason | 'disconnected'

export type EntryStatus = 'sent' | 'pending' | 'failed'

export type Entry = {
  /** Stable for the entry's life, across the echo of an own send. */
  readonly key: string
  id: string | null
  readonly cid: string | null
  at: number
  readonly from: string
  readonly fromName: string
  text: string
  readonly own: boolean
  status: EntryStatus
  reason: FailReason | null
}

export type Tab = {
  readonly key: TabKey
  readonly scope: ChatScope
  /** The other side of a direct conversation. */
  readonly peer: string | null
  peerName: string
  entries: Entry[]
  unread: number
}

export type Composed = { ok: true; msg: ChatSend } | { ok: false; error: CleanError }

export const TAB_CAP = 200

/** How far a lost send's local time may be from the server's. */
export const DELIVERED_SLACK_MS = 60_000

export function directKey(peer: string): TabKey {
  return `dm:${peer}`
}

export type ChatStateOptions = { cap?: number; now?: () => number }

export class ChatState {
  private selfId: string | null = null
  private selfName = ''
  private seq = 0
  private readonly tabsByKey = new Map<TabKey, Tab>()
  private readonly pending = new Map<string, Entry>()
  private current: TabKey = 'everyone'
  private visible = false
  private readonly cap: number
  private readonly now: () => number

  constructor(options: ChatStateOptions = {}) {
    this.cap = options.cap ?? TAB_CAP
    this.now = options.now ?? Date.now
    this.addTab('everyone', 'everyone', null, '')
    this.addTab('nearby', 'nearby', null, '')
  }

  get self(): string | null {
    return this.selfId
  }

  get active(): TabKey {
    return this.current
  }

  get open(): boolean {
    return this.visible
  }

  tabs(): readonly Tab[] {
    return [...this.tabsByKey.values()]
  }

  tab(key: TabKey): Tab | undefined {
    return this.tabsByKey.get(key)
  }

  unreadTotal(): number {
    let n = 0
    for (const tab of this.tabsByKey.values()) n += tab.unread
    return n
  }

  select(key: TabKey): boolean {
    if (!this.tabsByKey.has(key)) return false
    this.current = key
    this.markRead()
    return true
  }

  setOpen(open: boolean): void {
    this.visible = open
    this.markRead()
  }

  openDirect(peer: string, name: string): TabKey {
    const key = directKey(peer)
    const tab = this.tabsByKey.get(key)
    if (tab) tab.peerName = name
    else this.addTab(key, 'direct', peer, name)
    this.select(key)
    return key
  }

  // A new connection never echoes what the old one carried.
  welcome(selfId: string, selfName: string): void {
    this.selfId = selfId
    this.selfName = selfName
    for (const cid of [...this.pending.keys()]) this.fail(cid, 'disconnected')
  }

  /**
   * Replaces the everyone tab. Own sends without an id stay, placed by time,
   * except one lost with the connection that the history shows delivered: an
   * own message with the same text, close in time, not echoed before.
   */
  history(messages: readonly Chat[]): void {
    const tab = this.mustTab('everyone')
    const echoed = new Set(tab.entries.map((e) => e.id))
    const seen = new Set<string>()
    const entries: Entry[] = []
    for (const msg of messages) {
      if (msg.scope !== 'everyone' || seen.has(msg.id)) continue
      seen.add(msg.id)
      entries.push(this.entryFrom(msg))
    }

    const delivered = entries.filter((e) => e.own && !echoed.has(e.id))
    const local = tab.entries.filter((e) => {
      if (e.id !== null) return false
      if (e.status !== 'failed' || e.reason !== 'disconnected') return true
      const i = delivered.findIndex((d) => d.text === e.text && Math.abs(d.at - e.at) <= DELIVERED_SLACK_MS)
      if (i < 0) return true
      delivered.splice(i, 1)
      return false
    })
    tab.entries = mergeByTime(entries, local)
    this.trim(tab)
  }

  /** Adds msg and returns its tab, or null when it was a duplicate. */
  receive(msg: Chat): TabKey | null {
    const own = msg.from === this.selfId
    const peer = msg.scope === 'direct' ? (own ? msg.to : msg.from) : null
    if (peer === undefined || (msg.scope === 'direct' && peer === this.selfId)) return null
    const key: TabKey = peer === null ? (msg.scope === 'nearby' ? 'nearby' : 'everyone') : directKey(peer)

    let tab = this.tabsByKey.get(key)
    if (!tab) tab = this.addTab(key, 'direct', peer, own ? (peer ?? '') : msg.fromName)
    else if (peer !== null && !own) tab.peerName = msg.fromName
    if (tab.entries.some((e) => e.id === msg.id)) return null

    const echoed = own && msg.cid !== undefined ? this.pending.get(msg.cid) : undefined
    if (echoed && tab.entries.includes(echoed)) {
      this.pending.delete(echoed.cid ?? '')
      echoed.id = msg.id
      echoed.at = msg.at
      echoed.text = msg.text
      echoed.status = 'sent'
      echoed.reason = null
      return key
    }

    tab.entries.push(this.entryFrom(msg))
    this.trim(tab)
    if (!own && !(this.visible && this.current === key)) tab.unread++
    return key
  }

  /** Marks the send cid as failed; false when it is not pending. */
  fail(cid: string, reason: FailReason): boolean {
    const entry = this.pending.get(cid)
    if (!entry) return false
    this.pending.delete(cid)
    entry.status = 'failed'
    entry.reason = reason
    return true
  }

  /** Cleans raw and, if it can go, adds it to the tab as pending. */
  compose(key: TabKey, raw: string): Composed | null {
    const tab = this.tabsByKey.get(key)
    if (!tab || this.selfId === null) return null
    const cleaned = clean(raw)
    if (cleaned.error) return { ok: false, error: cleaned.error }

    const cid = `c${++this.seq}`
    const entry: Entry = {
      key: `c:${cid}`,
      id: null,
      cid,
      at: this.now(),
      from: this.selfId,
      fromName: this.selfName,
      text: cleaned.text,
      own: true,
      status: 'pending',
      reason: null,
    }
    tab.entries.push(entry)
    this.pending.set(cid, entry)
    this.trim(tab)

    const msg: ChatSend = { cid, scope: tab.scope, text: cleaned.text }
    if (tab.peer !== null) msg.to = tab.peer
    return { ok: true, msg }
  }

  private entryFrom(msg: Chat): Entry {
    return {
      key: `m:${msg.id}`,
      id: msg.id,
      cid: null,
      at: msg.at,
      from: msg.from,
      fromName: msg.fromName,
      text: msg.text,
      own: msg.from === this.selfId,
      status: 'sent',
      reason: null,
    }
  }

  private trim(tab: Tab): void {
    const extra = tab.entries.length - this.cap
    if (extra <= 0) return
    for (const entry of tab.entries.splice(0, extra)) {
      if (entry.cid !== null && this.pending.get(entry.cid) === entry) this.pending.delete(entry.cid)
    }
  }

  private markRead(): void {
    const tab = this.tabsByKey.get(this.current)
    if (tab && this.visible) tab.unread = 0
  }

  private addTab(key: TabKey, scope: ChatScope, peer: string | null, peerName: string): Tab {
    const tab: Tab = { key, scope, peer, peerName, entries: [], unread: 0 }
    this.tabsByKey.set(key, tab)
    return tab
  }

  private mustTab(key: TabKey): Tab {
    const tab = this.tabsByKey.get(key)
    if (!tab) throw new Error(`chat tab ${key} missing`)
    return tab
  }
}

/** Inserts extra into sorted by at, keeping the order of sorted and of ties. */
function mergeByTime(sorted: readonly Entry[], extra: readonly Entry[]): Entry[] {
  const out: Entry[] = []
  let i = 0
  for (const entry of [...extra].sort((a, b) => a.at - b.at)) {
    for (let next = sorted[i]; next !== undefined && next.at <= entry.at; next = sorted[++i]) out.push(next)
    out.push(entry)
  }
  return out.concat(sorted.slice(i))
}
