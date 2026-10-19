import { clean, MAX_LINES, MAX_RUNES } from '../chat/clean'
import type { Cleaned } from '../chat/clean'
import { atBottom, inputAction, keepFromGame, shouldFocusChat } from '../chat/keys'
import type { TypingGate } from '../chat/keys'
import { Roster } from '../chat/roster'
import { ChatState } from '../chat/state'
import type { Entry, FailReason, Tab, TabKey } from '../chat/state'
import type { Connection, ConnectionStatus } from '../net/connection'
import type { ServerMessage } from '../net/protocol'
import { requireElement } from './dom'

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

type RosterView = Pick<Roster, 'online' | 'name' | 'nearby'>

export function tabLabel(tab: Tab, roster: RosterView): string {
  switch (tab.scope) {
    case 'everyone':
      return 'Todos'
    case 'nearby':
      return 'Perto'
    case 'direct':
      return (tab.peer !== null && roster.name(tab.peer)) || tab.peerName || 'Conversa'
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
      const names = roster.nearby().map((id) => roster.name(id) ?? id)
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

export function counterText(cleaned: Cleaned): string {
  return `${cleaned.runes}/${MAX_RUNES}`
}

const timeFormat = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' })

type EntryView = { root: HTMLElement; time: HTMLTimeElement; state: HTMLElement; text: HTMLElement; shown: string }

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

export function createChat(link: ChatLink, gate: TypingGate): void {
  const root = requireElement('chat', HTMLElement)
  const toggle = requireElement('chat-toggle', HTMLButtonElement)
  const toggleBadge = requireElement('chat-toggle-badge', HTMLSpanElement)
  const panel = requireElement('chat-panel', HTMLElement)
  const close = requireElement('chat-close', HTMLButtonElement)
  const tabList = requireElement('chat-tabs', HTMLDivElement)
  const tabPanel = requireElement('chat-tabpanel', HTMLDivElement)
  const peopleToggle = requireElement('chat-people-toggle', HTMLButtonElement)
  const people = requireElement('chat-people', HTMLDivElement)
  const peopleList = requireElement('chat-roster', HTMLUListElement)
  const notice = requireElement('chat-notice', HTMLParagraphElement)
  const log = requireElement('chat-log', HTMLDivElement)
  const form = requireElement('chat-form', HTMLFormElement)
  const input = requireElement('chat-input', HTMLTextAreaElement)
  const status = requireElement('chat-status', HTMLSpanElement)
  const counter = requireElement('chat-count', HTMLSpanElement)
  const sendButton = requireElement('chat-send', HTMLButtonElement)

  const roster = new Roster()
  const state = new ChatState()
  const entryViews = new WeakMap<Entry, EntryView>()
  const tabButtons = new Map<TabKey, { button: HTMLButtonElement; label: HTMLSpanElement; badge: HTMLSpanElement }>()
  const personItems = new Map<string, { item: HTMLLIElement; button: HTMLButtonElement; name: HTMLSpanElement; near: HTMLSpanElement }>()
  let connected = false
  let shownTab: TabKey | null = null
  let draft = clean('')
  let error = ''
  let canSendHere = true

  const setOpen = (open: boolean) => {
    state.setOpen(open)
    panel.hidden = !open
    toggle.hidden = open
    toggle.setAttribute('aria-expanded', String(open))
  }

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
        button.id = `chat-tab-${tabButtons.size}`
        button.setAttribute('role', 'tab')
        button.setAttribute('aria-controls', tabPanel.id)
        const label = el('span', 'chat-tab-label')
        label.dir = 'auto'
        const badge = el('span', 'chat-badge')
        badge.setAttribute('aria-hidden', 'true')
        button.append(label, badge)
        const key = tab.key
        button.addEventListener('click', () => select(key))
        view = { button, label, badge }
        tabButtons.set(key, view)
      }
      const selected = tab.key === state.active
      const label = tabLabel(tab, roster)
      view.label.textContent = label
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
    toggleBadge.textContent = unread > 99 ? '99+' : String(unread)
    toggleBadge.hidden = unread === 0
    toggle.setAttribute('aria-label', tabAriaLabel('Abrir chat', unread))
  }

  const entryView = (entry: Entry): EntryView => {
    let view = entryViews.get(entry)
    if (view) return view
    const root = el('div', 'chat-msg')
    const head = el('div', 'chat-head')
    const from = el('span', 'chat-from', entry.fromName)
    from.dir = 'auto'
    const time = el('time', 'chat-time')
    const stateText = el('span', 'chat-state')
    const text = el('p', 'chat-text')
    text.dir = 'auto'
    head.append(from, time, stateText)
    root.append(head, text)
    root.classList.toggle('own', entry.own)
    view = { root, time, state: stateText, text, shown: '' }
    entryViews.set(entry, view)
    return view
  }

  const renderLog = (tab: Tab, forceBottom: boolean) => {
    const stick = forceBottom || shownTab !== tab.key || atBottom(log)
    shownTab = tab.key
    const nodes = tab.entries.map((entry) => {
      const view = entryView(entry)
      const shown = `${entry.status} ${entry.reason} ${entry.at} ${entry.text}`
      if (view.shown === shown) return view.root
      view.shown = shown
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

  const renderPeople = () => {
    const list = roster.list()
    peopleToggle.textContent = `Presentes (${list.length})`
    const items = list.map((person) => {
      let view = personItems.get(person.id)
      if (!view) {
        const item = el('li', 'chat-person')
        const button = el('button', 'chat-person-button')
        button.type = 'button'
        const name = el('span', 'chat-person-name')
        name.dir = 'auto'
        const near = el('span', 'chat-person-near', 'perto')
        button.append(name, near)
        item.append(button)
        const id = person.id
        button.addEventListener('click', () => openDirect(id))
        view = { item, button, name, near }
        personItems.set(id, view)
      }
      view.name.textContent = person.self ? `${person.name} (você)` : person.name
      view.near.hidden = !person.nearby
      view.button.disabled = person.self
      view.button.setAttribute('aria-label', person.self ? `${person.name}, você` : `Conversar com ${person.name}${person.nearby ? ', perto' : ''}`)
      return view.item
    })
    for (const id of [...personItems.keys()]) if (!roster.online(id)) personItems.delete(id)
    if (!sameChildren(peopleList, items)) peopleList.replaceChildren(...items)
  }

  const render = (forceBottom = false) => {
    const tab = state.tab(state.active)
    if (!tab) return
    renderTabs()
    const info = tabNotice(tab, roster)
    notice.textContent = info.text
    notice.classList.toggle('offline', !info.canSend)
    canSendHere = info.canSend
    renderLog(tab, forceBottom)
    renderPeople()
    renderComposer()
  }

  const select = (key: TabKey) => {
    if (!state.select(key)) return
    setError('')
    render(true)
  }

  const openDirect = (id: string) => {
    const name = roster.name(id)
    if (name === undefined || id === roster.self) return
    state.openDirect(id, name)
    people.hidden = true
    peopleToggle.setAttribute('aria-expanded', 'false')
    setOpen(true)
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
    const rosterChanged = roster.handle(msg)
    switch (msg.t) {
      case 'welcome': {
        const self = msg.d.players.find((p) => p.id === msg.d.selfId)
        state.welcome(msg.d.selfId, self?.name ?? '')
        root.hidden = false
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
    if (rosterChanged) render()
  }

  link.onMessage(handle)
  link.onStatus((s: ConnectionStatus) => {
    connected = s === 'open'
    render()
  })

  toggle.addEventListener('click', () => {
    setOpen(true)
    render(true)
    input.focus()
  })
  close.addEventListener('click', () => {
    setOpen(false)
    render()
    toggle.focus()
  })
  peopleToggle.addEventListener('click', () => {
    const stick = atBottom(log)
    people.hidden = !people.hidden
    peopleToggle.setAttribute('aria-expanded', String(!people.hidden))
    if (stick) log.scrollTop = log.scrollHeight
  })

  tabList.addEventListener('keydown', (e) => {
    const keys = state.tabs().map((t) => t.key)
    const i = keys.indexOf(state.active)
    let next: TabKey | undefined
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

  input.addEventListener('focus', () => gate.setTyping(true))
  input.addEventListener('blur', () => gate.setTyping(false))
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

  // The log and the people list scroll with these keys; the game would walk.
  const keepKeys = (e: KeyboardEvent) => {
    if (keepFromGame(e)) e.stopPropagation()
  }
  root.addEventListener('keydown', keepKeys)
  root.addEventListener('keyup', keepKeys)

  document.addEventListener('keydown', (e) => {
    if (root.hidden || !shouldFocusChat(e, e.target instanceof HTMLElement ? e.target : null)) return
    // Before focus, or the Enter would land in the textarea as a newline.
    e.preventDefault()
    setOpen(true)
    render(true)
    input.focus()
  })

  setOpen(window.matchMedia('(min-width: 900px)').matches)
}
