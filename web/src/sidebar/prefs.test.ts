import { describe, expect, it } from 'vitest'
import { applyTheme, themePrefs } from './prefs'

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

describe('theme', () => {
  it('follows the system until a theme is picked, and forgets it on going back', () => {
    const mem = new MemoryStorage()
    const prefs = themePrefs(() => mem as unknown as Storage)
    expect(prefs.load()).toBe('system')
    prefs.save('dark')
    expect(prefs.load()).toBe('dark')
    prefs.save('system')
    expect(mem.data.size).toBe(0)
    mem.setItem('vb-office-32.theme', 'sepia')
    expect(prefs.load()).toBe('system')
  })

  it('survives storage that throws', () => {
    const prefs = themePrefs(() => {
      throw new Error('denied')
    })
    expect(prefs.load()).toBe('system')
    expect(() => prefs.save('light')).not.toThrow()
  })

  it('sets data-theme on the root, none for the system', () => {
    const root = { dataset: {} as DOMStringMap }
    applyTheme(root, 'light')
    expect(root.dataset.theme).toBe('light')
    applyTheme(root, 'system')
    expect('theme' in root.dataset).toBe(false)
  })
})
