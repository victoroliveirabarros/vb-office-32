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
  // Own sends of closed tabs, whose echo must not reopen them.
  private readonly dropped = new Set<string>()
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

  /**
   * Closes a direct conversation, its messages with it, and selects the tab
   * before it when it was the active one. Only direct tabs close.
   */
  closeTab(key: TabKey): boolean {
    const tab = this.tabsByKey.get(key)
    if (!tab || tab.scope !== 'direct') return false
    const keys = [...this.tabsByKey.keys()]
    this.tabsByKey.delete(key)
    for (const entry of tab.entries) {
      if (entry.cid === null || this.pending.get(entry.cid) !== entry) continue
      this.pending.delete(entry.cid)
      this.dropped.add(entry.cid)
    }
    if (this.current === key) this.select(keys[keys.indexOf(key) - 1] ?? 'everyone')
    return true
  }

  // A new connection never echoes what the old one carried.
  welcome(selfId: string, selfName: string): void {
    this.selfId = selfId
    this.selfName = selfName
    this.dropped.clear()
    for (const cid of [...this.pending.keys()]) this.fail(cid, 'disconnected')
  }

  /** Replaces the everyone tab, keeping unconfirmed own sends at the end. */
  history(messages: readonly Chat[]): void {
    const tab = this.mustTab('everyone')
    const seen = new Set<string>()
    const entries: Entry[] = []
    for (const msg of messages) {
      if (msg.scope !== 'everyone' || seen.has(msg.id)) continue
      seen.add(msg.id)
      entries.push(this.entryFrom(msg))
    }
    tab.entries = [...entries, ...tab.entries.filter((e) => e.id === null)]
    this.trim(tab)
  }

  /** Adds msg and returns its tab, or null when it was a duplicate. */
  receive(msg: Chat): TabKey | null {
    const own = msg.from === this.selfId
    if (own && msg.cid !== undefined && this.dropped.delete(msg.cid)) return null
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
    this.dropped.delete(cid)
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
