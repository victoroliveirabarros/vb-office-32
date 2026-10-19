import { isEditable } from '../chat/keys'
import type { TypingGate } from '../chat/keys'
import {
  badgeText,
  close,
  DOCKED_QUERY,
  isPanel,
  itemLabel,
  itemText,
  NAV_ITEMS,
  navShortcut,
  open,
  openDrawer,
  pick,
  shownPanel,
  toggleExpanded,
} from '../sidebar/state'
import type { Layout, NavItem, PanelId, Sidebar, SidebarPrefs } from '../sidebar/state'
import { requireElement } from './dom'

export type SidebarHooks = {
  /** The Avatar item: opens the editor. */
  editAvatar(): void
  /** False while the chat or the editor holds the keyboard: the shortcuts wait. */
  keyboardFree(): boolean
}

export type SidebarApi = {
  /** Shows the sidebar once in the office. */
  start(): void
  open(panel: PanelId): void
  shown(): PanelId | null
  onShown(fn: (panel: PanelId | null) => void): void
  setCount(item: 'chat' | 'people', n: number): void
  /** Makes way for the map: the drawer closes, the docked panel stays. */
  revealMap(): void
}

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), a[href]'

/**
 * The sidebar and its panels. Docked (≥ 900 px) it is a column of icons,
 * with labels when expanded, and the panel opens beside it over the map;
 * on a phone it is a drawer over the map that holds the panel.
 */
export function createSidebar(prefs: SidebarPrefs, gate: TypingGate, hooks: SidebarHooks): SidebarApi {
  const html = document.documentElement
  const shell = requireElement('shell', HTMLDivElement)
  const toggle = requireElement('sidebar-toggle', HTMLButtonElement)
  const drawerClose = requireElement('drawer-close', HTMLButtonElement)
  const menu = requireElement('menu', HTMLButtonElement)
  const menuBadge = requireElement('menu-badge', HTMLSpanElement)
  const scrim = requireElement('scrim', HTMLDivElement)
  const panel = requireElement('panel', HTMLElement)
  const panelTitle = requireElement('panel-title', HTMLHeadingElement)
  const panelClose = requireElement('panel-close', HTMLButtonElement)
  const docked = window.matchMedia(DOCKED_QUERY)

  const buttons = new Map<NavItem, HTMLButtonElement>()
  for (const button of shell.querySelectorAll<HTMLButtonElement>('.nav-item')) {
    const item = NAV_ITEMS.find((i) => i === button.dataset.item)
    if (item) buttons.set(item, button)
  }
  const bodies = new Map<PanelId, HTMLElement>()
  for (const id of ['chat', 'people', 'rooms', 'settings'] as const) bodies.set(id, requireElement(`${id}-panel`, HTMLElement))
  const badges = { chat: requireElement('nav-chat-badge', HTMLSpanElement), people: requireElement('nav-people-badge', HTMLSpanElement) }
  const counts = { chat: 0, people: 0 }
  const listeners = new Set<(panel: PanelId | null) => void>()

  let state: Sidebar = prefs.load()
  let started = false
  let lastShown: PanelId | null = null

  const layout = (): Layout => (docked.matches ? 'docked' : 'drawer')
  const inDrawer = () => layout() === 'drawer'

  // While the drawer is open the rest of the page sleeps: focus and screen
  // readers stay inside it.
  const setInert = (on: boolean) => {
    for (const el of document.body.children) {
      if (el === shell || el === scrim || el instanceof HTMLDialogElement || el instanceof HTMLScriptElement) continue
      if (el instanceof HTMLElement) el.inert = on
    }
  }

  const render = () => {
    const lay = layout()
    const shown = started ? shownPanel(state, lay) : null
    const drawer = lay === 'drawer'
    const drawerOpen = drawer && state.drawerOpen
    if (started) html.dataset.sidebar = state.expanded ? 'expanded' : 'collapsed'
    if (shown && !drawer) html.dataset.panel = shown
    else delete html.dataset.panel
    shell.dataset.layout = lay
    shell.toggleAttribute('data-open', drawerOpen)
    shell.toggleAttribute('data-collapsed', !drawer && !state.expanded)
    shell.inert = drawer && !drawerOpen
    scrim.hidden = !drawerOpen
    menu.hidden = !started || !drawer
    menu.setAttribute('aria-expanded', String(drawerOpen))
    setInert(drawerOpen)

    toggle.setAttribute('aria-expanded', String(state.expanded))
    const toggleText = state.expanded ? 'Recolher menu' : 'Expandir menu'
    toggle.setAttribute('aria-label', toggleText)

    for (const [item, button] of buttons) {
      const active = item === shown || (drawer && item === state.panel)
      button.classList.toggle('active', active)
      if (isPanel(item)) button.setAttribute('aria-expanded', String(item === shown))
      const count = item === 'chat' || item === 'people' ? counts[item] : 0
      button.setAttribute('aria-label', itemLabel(item, count))
    }

    panel.hidden = shown === null
    for (const [id, body] of bodies) body.hidden = id !== shown
    panelTitle.textContent = shown ? itemText(shown) : ''

    if (shown !== lastShown) {
      lastShown = shown
      listeners.forEach((fn) => fn(shown))
    }
  }

  const set = (next: Sidebar) => {
    state = next
    prefs.save(state)
    render()
  }

  const focusItem = (item: NavItem | null) => {
    if (item) buttons.get(item)?.focus()
  }

  const closePanel = () => {
    const was = shownPanel(state, layout())
    if (inDrawer()) {
      set(close(state, 'drawer'))
      menu.focus()
      return
    }
    set(close(state, 'docked'))
    focusItem(was)
  }

  const choose = (item: NavItem) => {
    if (item === 'avatar') {
      if (!buttons.get('avatar')?.disabled) hooks.editAvatar()
      return
    }
    set(pick(state, item, layout()))
  }

  for (const [item, button] of buttons) {
    button.addEventListener('click', () => choose(item))
  }

  toggle.addEventListener('click', () => set(toggleExpanded(state)))
  panelClose.addEventListener('click', closePanel)
  drawerClose.addEventListener('click', closePanel)
  scrim.addEventListener('click', closePanel)
  menu.addEventListener('click', () => {
    set(openDrawer(state))
    focusItem(state.panel)
  })

  shell.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !e.defaultPrevented && (inDrawer() || shownPanel(state, 'docked') !== null)) {
      // The chat's box takes its own Esc first, to leave it.
      e.preventDefault()
      e.stopPropagation()
      closePanel()
    }
  })
  // On the way down, before the chat's box keeps its keys to itself.
  shell.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Tab' && inDrawer() && state.drawerOpen) trapTab(e)
    },
    true,
  )

  // The drawer keeps Tab inside it.
  const trapTab = (e: KeyboardEvent) => {
    const items = [...shell.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement)
    const first = items[0]
    const last = items[items.length - 1]
    if (!first || !last) return
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }

  // A field of a panel (search, device) takes the keyboard from the game;
  // the chat's box has its own owner.
  shell.addEventListener('focusin', (e) => {
    const target = e.target instanceof HTMLElement ? e.target : null
    if (target && target.id !== 'chat-input' && isEditable(target)) gate.setTyping('sidebar', true)
  })
  shell.addEventListener('focusout', (e) => {
    const next = e.relatedTarget instanceof HTMLElement ? e.relatedTarget : null
    if (!next || next.id === 'chat-input' || !shell.contains(next) || !isEditable(next)) gate.setTyping('sidebar', false)
  })

  window.addEventListener('keydown', (e) => {
    if (!started || !hooks.keyboardFree()) return
    const item = navShortcut(e)
    if (!item) return
    e.preventDefault()
    if (item === 'avatar') return choose(item)
    if (inDrawer()) set(open(state, item, 'drawer'))
    else choose(item)
    if (shownPanel(state, layout()) === item) focusItem(item)
  })

  docked.addEventListener('change', render)

  render()

  return {
    start() {
      started = true
      shell.hidden = false
      render()
    },
    open(id) {
      set(open(state, id, layout()))
    },
    shown: () => shownPanel(state, layout()),
    onShown(fn) {
      listeners.add(fn)
      fn(lastShown)
    },
    setCount(item, n) {
      if (counts[item] === n) return
      counts[item] = n
      const badge = badges[item]
      badge.textContent = badgeText(n)
      badge.hidden = n === 0
      if (item === 'chat') {
        menuBadge.textContent = badge.textContent
        menuBadge.hidden = n === 0
        menu.setAttribute('aria-label', n === 0 ? 'Abrir menu' : `Abrir menu, ${n} ${n === 1 ? 'mensagem não lida' : 'mensagens não lidas'}`)
      }
      render()
    },
    revealMap() {
      if (inDrawer() && state.drawerOpen) {
        set(close(state, 'drawer'))
        menu.focus()
      }
    },
  }
}
