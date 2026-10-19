import { isComposing } from '../chat/keys'
import type { KeyLike } from '../chat/keys'

export const PANELS = ['chat', 'people', 'rooms', 'settings'] as const
export type PanelId = (typeof PANELS)[number]

/** What the sidebar lists, in order; the avatar opens the editor instead of a panel. */
export const NAV_ITEMS = ['chat', 'people', 'rooms', 'avatar', 'settings'] as const
export type NavItem = (typeof NAV_ITEMS)[number]

/** Where the sidebar docks beside the map; narrower, it is a drawer over it (style.css agrees). */
export const DOCKED_QUERY = '(min-width: 900px)'

export type Layout = 'docked' | 'drawer'

/**
 * expanded: icons with labels or the rail of icons, when docked. panel: the
 * open panel; in the drawer, the one shown whenever it opens.
 */
export type Sidebar = { readonly expanded: boolean; readonly panel: PanelId | null; readonly drawerOpen: boolean }

export const INITIAL_SIDEBAR: Sidebar = { expanded: true, panel: 'chat', drawerOpen: false }

export function isPanel(item: unknown): item is PanelId {
  return typeof item === 'string' && (PANELS as readonly string[]).includes(item)
}

/** The panel on screen, if any. */
export function shownPanel(s: Sidebar, layout: Layout): PanelId | null {
  if (layout === 'drawer') return s.drawerOpen ? s.panel : null
  return s.panel
}

/**
 * A click on a panel's item: docked, the active one closes; in the drawer,
 * which always shows a panel, it stays.
 */
export function pick(s: Sidebar, panel: PanelId, layout: Layout): Sidebar {
  if (layout === 'drawer') return { ...s, panel, drawerOpen: true }
  return { ...s, panel: s.panel === panel ? null : panel }
}

export function open(s: Sidebar, panel: PanelId, layout: Layout): Sidebar {
  return layout === 'drawer' ? { ...s, panel, drawerOpen: true } : { ...s, panel }
}

/** Closes the panel; in the drawer the whole drawer, keeping the panel for next time. */
export function close(s: Sidebar, layout: Layout): Sidebar {
  return layout === 'drawer' ? { ...s, drawerOpen: false } : { ...s, panel: null }
}

export function openDrawer(s: Sidebar): Sidebar {
  return { ...s, drawerOpen: true, panel: s.panel ?? 'chat' }
}

export function toggleExpanded(s: Sidebar): Sidebar {
  return { ...s, expanded: !s.expanded }
}

/** Alt+1…5 picks the items in order; the physical key, since Alt changes the character on a Mac. */
export function navShortcut(e: KeyLike & { code?: string }): NavItem | null {
  if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.defaultPrevented || isComposing(e)) return null
  const match = /^(?:Digit|Numpad)([1-9])$/.exec(e.code ?? '')
  if (!match) return null
  return NAV_ITEMS[Number(match[1]) - 1] ?? null
}

export function badgeText(n: number): string {
  return n > 99 ? '99+' : String(n)
}

const ITEM_TEXT: Record<NavItem, string> = {
  chat: 'Chat',
  people: 'Pessoas',
  rooms: 'Salas',
  avatar: 'Avatar',
  settings: 'Configurações',
}

export function itemText(item: NavItem): string {
  return ITEM_TEXT[item]
}

/** The item's name for screen readers, with what its badge counts. */
export function itemLabel(item: NavItem, count: number): string {
  const text = ITEM_TEXT[item]
  if (item === 'chat' && count > 0) return `${text}, ${count} ${count === 1 ? 'não lida' : 'não lidas'}`
  if (item === 'people' && count > 0) return `${text}, ${count} no escritório`
  if (item === 'avatar') return 'Personalizar avatar'
  return text
}

const SIDEBAR_KEY = 'vb-office-32.sidebar'

export type SidebarPrefs = {
  load(): Sidebar
  save(s: Sidebar): void
}

// Storage may be missing or throw on access (private mode, blocked site
// data); the sidebar then starts as on a first visit.
export function sidebarPrefs(storage: () => Storage = () => localStorage): SidebarPrefs {
  return {
    load() {
      try {
        const raw = storage().getItem(SIDEBAR_KEY)
        if (raw === null) return INITIAL_SIDEBAR
        const saved: unknown = JSON.parse(raw)
        if (typeof saved !== 'object' || saved === null) return INITIAL_SIDEBAR
        const { expanded, panel } = saved as Record<string, unknown>
        return {
          expanded: typeof expanded === 'boolean' ? expanded : INITIAL_SIDEBAR.expanded,
          panel: panel === null || isPanel(panel) ? panel : INITIAL_SIDEBAR.panel,
          drawerOpen: false,
        }
      } catch {
        return INITIAL_SIDEBAR
      }
    },
    save(s) {
      try {
        storage().setItem(SIDEBAR_KEY, JSON.stringify({ expanded: s.expanded, panel: s.panel }))
      } catch {
        // see above
      }
    },
  }
}
