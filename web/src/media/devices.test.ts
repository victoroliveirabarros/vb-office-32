import { describe, expect, it } from 'vitest'
import { chosenDevice, deviceOptions, devicePrefs, namesHidden } from './devices'

const dev = (deviceId: string, kind: string, label = '') => ({ deviceId, kind, label })

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

describe('devices', () => {
  const list = [
    dev('default', 'audioinput', 'Padrão - Microfone USB'),
    dev('usb', 'audioinput', 'Microfone USB'),
    dev('usb', 'audioinput', 'Microfone USB'),
    dev('cam', 'videoinput', ''),
    dev('cam2', 'videoinput', ' '),
    dev('', 'audiooutput', ''),
  ]

  it('lists a kind once each, numbering hidden names and skipping hidden ids', () => {
    expect(deviceOptions(list, 'audioinput')).toEqual([
      { id: 'default', label: 'Padrão - Microfone USB' },
      { id: 'usb', label: 'Microfone USB' },
    ])
    expect(deviceOptions(list, 'videoinput')).toEqual([
      { id: 'cam', label: 'Câmera 1' },
      { id: 'cam2', label: 'Câmera 2' },
    ])
    expect(deviceOptions(list, 'audiooutput')).toEqual([])
  })

  it('tells when the browser still hides the names', () => {
    expect(namesHidden(list, 'videoinput')).toBe(true)
    expect(namesHidden(list, 'audioinput')).toBe(false)
    expect(namesHidden([], 'audioinput')).toBe(false)
  })

  it('shows the saved choice, else the one in use, else the first', () => {
    const options = deviceOptions(list, 'audioinput')
    expect(chosenDevice(options, 'usb', 'default')).toBe('usb')
    expect(chosenDevice(options, 'gone', 'usb')).toBe('usb')
    expect(chosenDevice(options, undefined, undefined)).toBe('default')
    expect(chosenDevice([], 'usb', undefined)).toBeNull()
  })

  it('remembers a device per kind and ignores junk', () => {
    const mem = new MemoryStorage()
    const prefs = devicePrefs(() => mem as unknown as Storage)
    expect(prefs.load()).toEqual({})
    prefs.save('audioinput', 'usb')
    prefs.save('videoinput', 'cam')
    prefs.save('audioinput', 'default')
    expect(prefs.load()).toEqual({ audioinput: 'default', videoinput: 'cam' })
    mem.setItem('vb-office-32.devices', '{"audioinput":3,"speaker":"x","audiooutput":"out"}')
    expect(prefs.load()).toEqual({ audiooutput: 'out' })
    mem.setItem('vb-office-32.devices', '[')
    expect(prefs.load()).toEqual({})
  })

  it('survives storage that throws', () => {
    const prefs = devicePrefs(() => {
      throw new Error('denied')
    })
    expect(prefs.load()).toEqual({})
    expect(() => prefs.save('audioinput', 'usb')).not.toThrow()
  })
})
