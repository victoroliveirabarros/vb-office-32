import { describe, expect, it } from 'vitest'
import { badgeText, close, INITIAL_SIDEBAR, itemLabel, navShortcut, open, openDrawer, pick, shownPanel, sidebarPrefs, toggleExpanded } from './state'
import type { Sidebar } from './state'

class MemoryStorage {
  readonly data = new Map<string, string>()
  getItem(key: string): string | null {
    return this.data.get(key) ?? null
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value)
  }
  removeItem(key: string): void {
    this.data.delete(key)
  }
}

const storage = (s: MemoryStorage) => () => s as unknown as Storage
const broken = () => {
  throw new Error('denied')
}

const docked: Sidebar = { expanded: true, panel: null, drawerOpen: false }

describe('sidebar state', () => {
  it('opens one panel at a time and closes the active one on a second click, docked', () => {
    let s = pick(docked, 'people', 'docked')
    expect(shownPanel(s, 'docked')).toBe('people')
    s = pick(s, 'rooms', 'docked')
    expect(shownPanel(s, 'docked')).toBe('rooms')
    s = pick(s, 'rooms', 'docked')
    expect(shownPanel(s, 'docked')).toBeNull()
  })

  it('keeps a panel in the open drawer, which shows nothing while closed', () => {
    let s = openDrawer({ ...docked })
    expect(s).toMatchObject({ drawerOpen: true, panel: 'chat' })
    s = pick(s, 'people', 'drawer')
    s = pick(s, 'people', 'drawer')
    expect(shownPanel(s, 'drawer')).toBe('people')
    s = close(s, 'drawer')
    expect(shownPanel(s, 'drawer')).toBeNull()
    expect(openDrawer(s).panel).toBe('people')
  })

  it('opens a panel from elsewhere (Enter, a click on an avatar) in either layout', () => {
    expect(shownPanel(open(docked, 'chat', 'docked'), 'docked')).toBe('chat')
    expect(open(docked, 'chat', 'drawer')).toMatchObject({ panel: 'chat', drawerOpen: true })
    expect(close(open(docked, 'chat', 'docked'), 'docked').panel).toBeNull()
  })

  it('collapses to the rail and back', () => {
    expect(toggleExpanded(docked).expanded).toBe(false)
    expect(toggleExpanded(toggleExpanded(docked)).expanded).toBe(true)
  })

  it('maps Alt+1…5 to the items by the physical key', () => {
    expect(navShortcut({ key: '1', code: 'Digit1', altKey: true })).toBe('chat')
    expect(navShortcut({ key: '¡', code: 'Digit1', altKey: true })).toBe('chat')
    expect(navShortcut({ key: '4', code: 'Numpad4', altKey: true })).toBe('avatar')
    expect(navShortcut({ key: '5', code: 'Digit5', altKey: true })).toBe('settings')
    expect(navShortcut({ key: '6', code: 'Digit6', altKey: true })).toBeNull()
    expect(navShortcut({ key: '1', code: 'Digit1' })).toBeNull()
    expect(navShortcut({ key: '1', code: 'Digit1', altKey: true, ctrlKey: true })).toBeNull()
    expect(navShortcut({ key: '1', code: 'Digit1', altKey: true, shiftKey: true })).toBeNull()
    expect(navShortcut({ key: '1', code: 'Digit1', altKey: true, defaultPrevented: true })).toBeNull()
    expect(navShortcut({ key: 'Process', code: 'Digit1', altKey: true, keyCode: 229 })).toBeNull()
  })

  it('names the items with their counts', () => {
    expect(itemLabel('chat', 0)).toBe('Chat')
    expect(itemLabel('chat', 1)).toBe('Chat, 1 não lida')
    expect(itemLabel('chat', 3)).toBe('Chat, 3 não lidas')
    expect(itemLabel('people', 4)).toBe('Pessoas, 4 no escritório')
    expect(itemLabel('avatar', 0)).toBe('Personalizar avatar')
    expect(badgeText(7)).toBe('7')
    expect(badgeText(120)).toBe('99+')
  })

  it('remembers the width and the panel, never an open drawer', () => {
    const mem = new MemoryStorage()
    const prefs = sidebarPrefs(storage(mem))
    expect(prefs.load()).toEqual(INITIAL_SIDEBAR)
    prefs.save({ expanded: false, panel: 'rooms', drawerOpen: true })
    expect(prefs.load()).toEqual({ expanded: false, panel: 'rooms', drawerOpen: false })
    prefs.save({ expanded: true, panel: null, drawerOpen: false })
    expect(prefs.load().panel).toBeNull()
  })

  it('falls back on junk and on storage that throws', () => {
    const mem = new MemoryStorage()
    mem.setItem('vb-office-32.sidebar', '{"expanded":"yes","panel":"avatar"}')
    expect(sidebarPrefs(storage(mem)).load()).toEqual(INITIAL_SIDEBAR)
    mem.setItem('vb-office-32.sidebar', 'not json')
    expect(sidebarPrefs(storage(mem)).load()).toEqual(INITIAL_SIDEBAR)
    const prefs = sidebarPrefs(broken)
    expect(prefs.load()).toEqual(INITIAL_SIDEBAR)
    expect(() => prefs.save(docked)).not.toThrow()
  })
})
