import { describe, expect, it } from 'vitest'
import { avatarPrefs } from './prefs'

function memory(): Storage {
  const items = new Map<string, string>()
  return {
    get length() {
      return items.size
    },
    clear: () => items.clear(),
    getItem: (k) => items.get(k) ?? null,
    key: (i) => [...items.keys()][i] ?? null,
    removeItem: (k) => void items.delete(k),
    setItem: (k, v) => void items.set(k, v),
  }
}

const look = { skin: 1, hair: 2, hairColor: 3, shirt: 4, pants: 0, acc: 1 }

describe('avatarPrefs', () => {
  it('saves the compact form under its key and loads it back', () => {
    const storage = memory()
    const prefs = avatarPrefs(() => storage)
    expect(prefs.load()).toBeNull()
    prefs.save(look)
    expect(storage.getItem('vb-office-32.avatar')).toBe('1.2.3.4.0.1')
    expect(prefs.load()).toEqual(look)
  })

  it('drops a saved look this catalog cannot read', () => {
    const storage = memory()
    storage.setItem('vb-office-32.avatar', '9.9.9')
    expect(avatarPrefs(() => storage).load()).toBeNull()
    storage.setItem('vb-office-32.avatar', '{"skin":1}')
    expect(avatarPrefs(() => storage).load()).toBeNull()
  })

  it('survives storage that throws', () => {
    const throwing = (): Storage => {
      throw new DOMException('denied', 'SecurityError')
    }
    const prefs = avatarPrefs(throwing)
    expect(prefs.load()).toBeNull()
    expect(() => prefs.save(look)).not.toThrow()

    const broken = memory()
    broken.getItem = () => {
      throw new Error('blocked')
    }
    broken.setItem = () => {
      throw new DOMException('full', 'QuotaExceededError')
    }
    expect(avatarPrefs(() => broken).load()).toBeNull()
    expect(() => avatarPrefs(() => broken).save(look)).not.toThrow()
  })
})
