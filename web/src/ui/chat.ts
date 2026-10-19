import { clean, MAX_LINES, MAX_RUNES } from '../chat/clean'
import type { Cleaned } from '../chat/clean'
import { atBottom, inputAction, keepFromGame, shouldFocusChat } from '../chat/keys'
import type { TypingGate } from '../chat/keys'
import type { RosterFeed } from '../chat/feed'
import type { Person, Roster } from '../chat/roster'
import { ChatState } from '../chat/state'
import type { Entry, FailReason, Tab, TabKey } from '../chat/state'
import type { Connection, ConnectionStatus } from '../net/connection'
import type { ServerMessage } from '../net/protocol'
import { icon, requireElement } from './dom'

// Everything user-supplied reaches the page through textContent only.

export type ChatLink = Pick<Connection, 'send' | 'onMessage' | 'onStatus'>

const REASON_TEXT: Record<FailReason, string> = {
  rate_limited: 'muitas mensagens seguidas, aguarde um pouco',
  too_long: `passa de ${MAX_RUNES} caracteres ou ${MAX_LINES} linhas`,
  empty: 'mensagem vazia',
  offline: 'a pessoa está offline',
  invalid: 'mensagem recusada',
  disconnected: 'conexão perdida',
}

export function failureText(reason: FailReason | null): string {
  return `Não enviada: ${REASON_TEXT[reason ?? 'invalid']}`
}

type RosterView = Pick<Roster, 'online' | 'label' | 'labelFor' | 'nearby' | 'room' | 'inOurRoom'>

export function peerLabel(tab: Tab, roster: RosterView): string {
  if (tab.peer === null) return tab.peerName
  return roster.label(tab.peer) ?? (tab.peerName === '' ? '' : roster.labelFor(tab.peer, tab.peerName))
}

export function tabLabel(tab: Tab, roster: RosterView): string {
  switch (tab.scope) {
    case 'everyone':
      return 'Todos'
    case 'nearby':
      return roster.room?.name ?? 'Perto'
    case 'direct':
      return peerLabel(tab, roster) || 'Conversa'
  }
}

export function tabAriaLabel(label: string, unread: number): string {
  if (unread === 0) return label
  return `${label}, ${unread} ${unread === 1 ? 'não lida' : 'não lidas'}`
}

export type Notice = { text: string; canSend: boolean }

export function tabNotice(tab: Tab, roster: RosterView): Notice {
  switch (tab.scope) {
    case 'everyone':
      return { text: 'Todos no escritório veem, inclusive quem entrar depois.', canSend: true }
    case 'nearby': {
      const names = roster.nearby().map((id) => roster.label(id) ?? id)
      if (roster.room) {
        if (names.length === 0) return { text: 'Visível só para quem está na sala. Ninguém mais aqui agora; só você verá.', canSend: true }
        return { text: `Visível só para quem está na sala: ${names.join(', ')}.`, canSend: true }
      }
      if (names.length === 0) return { text: 'Ninguém perto de você agora; só você verá.', canSend: true }
      return { text: `Perto de você agora: ${names.join(', ')}.`, canSend: true }
    }
    case 'direct': {
      const label = tabLabel(tab, roster)
      if (tab.peer === null || !roster.online(tab.peer)) return { text: `${label} está offline.`, canSend: false }
      return { text: `Só você e ${label} veem.`, canSend: true }
    }
  }
}

export type PersonTag = { text: string; kind: 'near' | 'room' | 'elsewhere' }

/** Where someone else is from our point of view: in our room, near us, or in another room. */
export function personTag(person: Person, roster: Pick<Roster, 'room' | 'inOurRoom'>): PersonTag | null {
  if (person.self) return null
  if (roster.inOurRoom(person.id)) return { text: 'na sala', kind: 'room' }
  if (!roster.room && person.nearby) return { text: 'perto', kind: 'near' }
  if (person.room) return { text: person.room.name, kind: 'elsewhere' }
  return null
}

export function personAriaLabel(person: Person, tag: PersonTag | null): string {
  if (person.self) return `${person.label}, você`
  return `Conversar com ${person.label}${tag ? `, ${tag.text}` : ''}`
}

export function counterText(cleaned: Cleaned): string {
  return `${cleaned.runes}/${MAX_RUNES}`
}

const timeFormat = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' })

type EntryView = { root: HTMLElement; from: HTMLElement; time: HTMLTimeElement; state: HTMLElement; text: HTMLElement; shown: string }

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function sameChildren(parent: Element, nodes: readonly Element[]): boolean {
  const { children } = parent
  return children.length === nodes.length && nodes.every((node, i) => children[i] === node)
}

export type ChatApi = {
  /** Opens the direct conversation with id, unless it is us or offline. */
  openDirect(id: string): void
  /** The chat's panel was shown or hidden. */
  setShown(shown: boolean): void
  /** Puts the cursor in the message box. */
  focus(): void
}

/** Where the chat lives: a panel of the sidebar. */
export type ChatHost = {
  show(): void
  unread(n: number): void
}

export function createChat(link: ChatLink, gate: TypingGate, feed: RosterFeed, host: ChatHost): ChatApi {
  const tabList = requireElement('chat-tabs', HTMLDivElement)
  const tabPanel = requireElement('chat-tabpanel', HTMLDivElement)
  const notice = requireElement('chat-notice', HTMLParagraphElement)
  const closeDirect = requireElement('chat-dm-close', HTMLButtonElement)
  const log = requireElement('chat-log', HTMLDivElement)
  const form = requireElement('chat-form', HTMLFormElement)
  const input = requireElement('chat-input', HTMLTextAreaElement)
  const status = requireElement('chat-status', HTMLSpanElement)
  const counter = requireElement('chat-count', HTMLSpanElement)
  const sendButton = requireElement('chat-send', HTMLButtonElement)

  const roster = feed.roster
  const state = new ChatState()
  const entryViews = new WeakMap<Entry, EntryView>()
  const tabButtons = new Map<TabKey, { button: HTMLButtonElement; label: HTMLSpanElement; badge: HTMLSpanElement }>()
  let tabSeq = 0
  let connected = false
  let shownTab: TabKey | null = null
  let draft = clean('')
  let error = ''
  let canSendHere = true
  let unreadShown = -1

  const setError = (text: string) => {
    error = text
    renderComposer()
  }

  const renderComposer = () => {
    sendButton.disabled = !connected || !canSendHere || draft.error !== null
    let text = error
    if (draft.error === 'too_long') text = `Mensagem longa demais (${counterText(draft)}, até ${MAX_LINES} linhas)`
    else if (!connected) text = 'Sem conexão com o escritório'
    status.textContent = text
    counter.textContent = counterText(draft)
    counter.classList.toggle('over', draft.error === 'too_long')
  }

  const renderTabs = () => {
    const buttons: HTMLButtonElement[] = []
    for (const tab of state.tabs()) {
      let view = tabButtons.get(tab.key)
      if (!view) {
        const button = el('button', 'chat-tab')
        button.type = 'button'
        button.id = `chat-tab-${tabSeq++}`
        button.setAttribute('role', 'tab')
        button.setAttribute('aria-controls', tabPanel.id)
        const label = el('span', 'chat-tab-label')
        label.dir = 'auto'
        const badge = el('span', 'chat-badge')
        badge.setAttribute('aria-hidden', 'true')
        button.append(label, badge)
        const key = tab.key
        if (tab.scope === 'direct') {
          // Mouse shortcut; keyboards use Delete or the button in the panel.
          const x = el('span', 'chat-tab-close')
          x.setAttribute('aria-hidden', 'true')
          x.title = 'Fechar conversa'
          x.append(icon('x'))
          button.append(x)
          button.setAttribute('aria-keyshortcuts', 'Delete')
        }
        button.addEventListener('click', (e) => {
          if (e.target instanceof Element && e.target.closest('.chat-tab-close')) closeTab(key)
          else select(key)
        })
        view = { button, label, badge }
        tabButtons.set(key, view)
      }
      const selected = tab.key === state.active
      const label = tabLabel(tab, roster)
      view.label.textContent = label
      view.button.title = label
      view.badge.textContent = tab.unread > 99 ? '99+' : String(tab.unread)
      view.badge.hidden = tab.unread === 0
      view.button.setAttribute('aria-label', tabAriaLabel(label, tab.unread))
      view.button.setAttribute('aria-selected', String(selected))
      view.button.tabIndex = selected ? 0 : -1
      view.button.classList.toggle('offline', tab.scope === 'direct' && (tab.peer === null || !roster.online(tab.peer)))
      if (selected) tabPanel.setAttribute('aria-labelledby', view.button.id)
      buttons.push(view.button)
    }
    if (!sameChildren(tabList, buttons)) tabList.replaceChildren(...buttons)

    const unread = state.unreadTotal()
    if (unread !== unreadShown) host.unread(unread)
    unreadShown = unread
  }

  const entryView = (entry: Entry): EntryView => {
    let view = entryViews.get(entry)
    if (view) return view
    const root = el('div', 'chat-msg')
    const head = el('div', 'chat-head')
    const from = el('span', 'chat-from')
    from.dir = 'auto'
    const time = el('time', 'chat-time')
    const stateText = el('span', 'chat-state')
    const text = el('p', 'chat-text')
    text.dir = 'auto'
    head.append(from, time, stateText)
    root.append(head, text)
    root.classList.toggle('own', entry.own)
    view = { root, from, time, state: stateText, text, shown: '' }
    entryViews.set(entry, view)
    return view
  }

  const renderLog = (tab: Tab, forceBottom: boolean) => {
    const stick = forceBottom || shownTab !== tab.key || atBottom(log)
    shownTab = tab.key
    const nodes = tab.entries.map((entry) => {
      const view = entryView(entry)
      const from = roster.labelFor(entry.from, entry.fromName)
      const shown = `${entry.status} ${entry.reason} ${entry.at} ${from}\n${entry.text}`
      if (view.shown === shown) return view.root
      view.shown = shown
      view.from.textContent = from
      const at = new Date(entry.at)
      const valid = Number.isFinite(at.getTime())
      view.time.dateTime = valid ? at.toISOString() : ''
      view.time.textContent = valid ? timeFormat.format(at) : ''
      view.text.textContent = entry.text
      view.root.classList.toggle('pending', entry.status === 'pending')
      view.root.classList.toggle('failed', entry.status === 'failed')
      view.state.textContent = entry.status === 'pending' ? 'enviando…' : entry.status === 'failed' ? failureText(entry.reason) : ''
      return view.root
    })
    if (!sameChildren(log, nodes)) log.replaceChildren(...nodes)
    if (stick) log.scrollTop = log.scrollHeight
  }

  const render = (forceBottom = false) => {
    const tab = state.tab(state.active)
    if (!tab) return
    renderTabs()
    const info = tabNotice(tab, roster)
    notice.textContent = info.text
    notice.classList.toggle('offline', !info.canSend)
    closeDirect.hidden = tab.scope !== 'direct'
    closeDirect.setAttribute('aria-label', `Fechar conversa com ${tabLabel(tab, roster)}`)
    canSendHere = info.canSend
    renderLog(tab, forceBottom)
    renderComposer()
  }

  const select = (key: TabKey) => {
    if (!state.select(key)) return
    setError('')
    render(true)
  }

  const closeTab = (key: TabKey) => {
    if (!state.closeTab(key)) return
    tabButtons.delete(key)
    setError('')
    render(true)
    tabButtons.get(state.active)?.button.focus()
  }

  const openDirect = (id: string) => {
    const name = roster.name(id)
    if (name === undefined || id === roster.self) return
    state.openDirect(id, name)
    host.show()
    setError('')
    render(true)
    input.focus()
  }

  const send = () => {
    const tab = state.tab(state.active)
    if (!tab || sendButton.disabled) return
    const composed = state.compose(tab.key, input.value)
    if (!composed) return
    if (!composed.ok) {
      setError(failureText(composed.error))
      return
    }
    if (!link.send({ t: 'chat', d: composed.msg })) state.fail(composed.msg.cid, 'disconnected')
    input.value = ''
    draft = clean('')
    setError('')
    render(true)
  }

  const handle = (msg: ServerMessage) => {
    switch (msg.t) {
      case 'welcome': {
        const self = msg.d.players.find((p) => p.id === msg.d.selfId)
        state.welcome(msg.d.selfId, self?.name ?? '')
        return render()
      }
      case 'chat':
        if (state.receive(msg.d)) render()
        return
      case 'chatHistory':
        log.setAttribute('aria-busy', 'true')
        state.history(msg.d.messages)
        render()
        requestAnimationFrame(() => log.setAttribute('aria-busy', 'false'))
        return
      case 'chatError':
        if (state.fail(msg.d.cid, msg.d.reason)) {
          setError(failureText(msg.d.reason))
          render()
        }
        return
    }
  }

  link.onMessage(handle)
  // Names, who is near and rooms show in the tabs and notices.
  feed.onChange(() => render())
  link.onStatus((s: ConnectionStatus) => {
    connected = s === 'open'
    render()
  })

  tabList.addEventListener('keydown', (e) => {
    const keys = state.tabs().map((t) => t.key)
    const i = keys.indexOf(state.active)
    let next: TabKey | undefined
    if (e.key === 'Delete' && state.tab(state.active)?.scope === 'direct') {
      e.preventDefault()
      e.stopPropagation()
      closeTab(state.active)
      return
    }
    if (e.key === 'ArrowRight') next = keys[(i + 1) % keys.length]
    else if (e.key === 'ArrowLeft') next = keys[(i - 1 + keys.length) % keys.length]
    else if (e.key === 'Home') next = keys[0]
    else if (e.key === 'End') next = keys[keys.length - 1]
    if (next === undefined) return
    // Arrow keys also walk the avatar; the tab list keeps them.
    e.preventDefault()
    e.stopPropagation()
    select(next)
    tabButtons.get(next)?.button.focus()
  })

  form.addEventListener('submit', (e) => {
    e.preventDefault()
    send()
    input.focus()
  })

  input.addEventListener('focus', () => gate.setTyping('chat', true))
  input.addEventListener('blur', () => gate.setTyping('chat', false))
  input.addEventListener('input', () => {
    draft = clean(input.value)
    error = ''
    renderComposer()
  })
  input.addEventListener('keydown', (e) => {
    // The game listens on window; nothing typed here may reach it.
    e.stopPropagation()
    const action = inputAction(e)
    if (action === null) return
    e.preventDefault()
    if (action === 'send') send()
    else input.blur()
  })
  input.addEventListener('keyup', (e) => e.stopPropagation())

  // The log scrolls with these keys; the game would walk.
  const keepKeys = (e: KeyboardEvent) => {
    if (keepFromGame(e)) e.stopPropagation()
  }
  log.addEventListener('keydown', keepKeys)
  log.addEventListener('keyup', keepKeys)

  document.addEventListener('keydown', (e) => {
    if (state.self === null || !shouldFocusChat(e, e.target instanceof HTMLElement ? e.target : null)) return
    // Before focus, or the Enter would land in the textarea as a newline.
    e.preventDefault()
    host.show()
    render(true)
    input.focus()
  })

  closeDirect.addEventListener('click', () => closeTab(state.active))

  return {
    openDirect,
    setShown(shown) {
      if (shown === state.open) return
      state.setOpen(shown)
      render(shown)
    },
    focus() {
      input.focus()
    },
  }
}
