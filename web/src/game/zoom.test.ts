import { describe, expect, it } from 'vitest'
import {
  cameraBounds,
  clampZoom,
  defaultZoom,
  pinchLevel,
  textResolution,
  WheelSteps,
  Zoom,
  zoomKey,
  zoomPrefs,
  zoomRange,
} from './zoom'

// The office: 50×25 tiles of 32 px.
const MAP = { width: 1600, height: 800 }
const DESKTOP = { width: 1280, height: 800 }
const PHONE = { width: 390, height: 844 }
const view = (width: number, height: number) => ({ width, height })

describe('zoomRange', () => {
  it('goes from the whole map to a few tiles across', () => {
    expect(zoomRange(DESKTOP, MAP)).toEqual({ min: 1, max: 4 })
    expect(zoomRange(PHONE, MAP)).toEqual({ min: 1, max: 3 })
    expect(zoomRange(view(360, 640), MAP)).toEqual({ min: 1, max: 3 })
    expect(zoomRange(view(320, 568), MAP)).toEqual({ min: 1, max: 2 })
  })

  it('does not zoom out past the map on both axes', () => {
    expect(zoomRange(view(1920, 1080), MAP)).toEqual({ min: 2, max: 4 })
    expect(zoomRange(view(3840, 2160), MAP)).toEqual({ min: 3, max: 4 })
    expect(zoomRange(view(1600, 900), MAP).min).toBe(1)
  })

  it('never inverts on tiny views', () => {
    expect(zoomRange(view(100, 100), MAP)).toEqual({ min: 1, max: 1 })
    expect(zoomRange(view(0, 0), MAP)).toEqual({ min: 1, max: 1 })
  })
})

describe('defaultZoom', () => {
  it('is 3× on a desktop and 2× on a phone', () => {
    expect(defaultZoom(DESKTOP, MAP)).toBe(3)
    expect(defaultZoom(view(1366, 768), MAP)).toBe(3)
    expect(defaultZoom(view(1440, 900), MAP)).toBe(3)
    expect(defaultZoom(PHONE, MAP)).toBe(2)
    expect(defaultZoom(view(844, 390), MAP)).toBe(2)
    expect(defaultZoom(view(360, 800), MAP)).toBe(2)
  })

  it('scales with the view and stays in range', () => {
    expect(defaultZoom(view(1920, 1080), MAP)).toBe(4)
    expect(defaultZoom(view(1024, 768), MAP)).toBe(2)
    expect(defaultZoom(view(320, 568), MAP)).toBe(1)
    for (const v of [DESKTOP, PHONE, view(3840, 2160), view(100, 100)]) {
      const { min, max } = zoomRange(v, MAP)
      expect(defaultZoom(v, MAP)).toBeGreaterThanOrEqual(min)
      expect(defaultZoom(v, MAP)).toBeLessThanOrEqual(max)
    }
  })
})

describe('clampZoom', () => {
  it('rounds to a level in range', () => {
    expect(clampZoom(2.4, { min: 1, max: 4 })).toBe(2)
    expect(clampZoom(2.6, { min: 1, max: 4 })).toBe(3)
    expect(clampZoom(9, { min: 1, max: 4 })).toBe(4)
    expect(clampZoom(0, { min: 2, max: 4 })).toBe(2)
  })
})

describe('cameraBounds', () => {
  it('is the map when the view fits in it', () => {
    expect(cameraBounds(DESKTOP, MAP, 2)).toEqual({ x: 0, y: 0, width: 1600, height: 800 })
  })

  it('centers the map on an axis the view is larger on', () => {
    expect(cameraBounds(PHONE, MAP, 1)).toEqual({ x: 0, y: -22, width: 1600, height: 844 })
    expect(cameraBounds(view(1920, 1080), MAP, 1)).toEqual({ x: -160, y: -140, width: 1920, height: 1080 })
  })
})

describe('textResolution', () => {
  it('follows the zoom and the pixel ratio, within limits', () => {
    expect(textResolution(1, 1)).toBe(1)
    expect(textResolution(3, 1)).toBe(3)
    expect(textResolution(2, 1.5)).toBe(3)
    expect(textResolution(4, 3)).toBe(8)
    expect(textResolution(0.5, 1)).toBe(1)
  })
})

describe('pinchLevel', () => {
  const range = { min: 1, max: 4 }

  it('scales the starting level by the pinch', () => {
    expect(pinchLevel(2, 1, 2, range)).toBe(2)
    expect(pinchLevel(2, 1.5, 2, range)).toBe(3)
    expect(pinchLevel(2, 2, 2, range)).toBe(4)
    expect(pinchLevel(3, 0.5, 3, range)).toBe(2)
    expect(pinchLevel(3, 0.3, 3, range)).toBe(1)
  })

  it('holds near the midpoint between levels', () => {
    expect(pinchLevel(2, 1.27, 2, range)).toBe(2)
    expect(pinchLevel(2, 1.31, 2, range)).toBe(3)
    // Back from 3: only once clearly under 2.5.
    expect(pinchLevel(2, 1.23, 3, range)).toBe(3)
    expect(pinchLevel(2, 1.19, 3, range)).toBe(2)
  })

  it('stays in range', () => {
    expect(pinchLevel(4, 3, 4, range)).toBe(4)
    expect(pinchLevel(1, 0.1, 1, range)).toBe(1)
  })
})

describe('WheelSteps', () => {
  it('takes one step per mouse notch', () => {
    const wheel = new WheelSteps()
    expect(wheel.push(-100, 0, 0)).toBe(1)
    expect(wheel.push(-100, 0, 50)).toBe(1)
    expect(wheel.push(100, 0, 100)).toBe(-1)
    expect(wheel.push(3, 1, 1000)).toBe(-1)
    expect(wheel.push(-1, 2, 2000)).toBe(1)
  })

  it('adds up a trackpad pinch', () => {
    const wheel = new WheelSteps()
    const steps = [-8, -8, -8, -8, -8, -8, -8, -8, -8, -8].map((dy, i) => wheel.push(dy, 0, i * 16))
    expect(steps.filter((s) => s === 1)).toHaveLength(2)
    expect(steps.filter((s) => s !== 0 && s !== 1)).toHaveLength(0)
  })

  it('forgets after a pause or a change of direction', () => {
    const wheel = new WheelSteps()
    expect(wheel.push(-30, 0, 0)).toBe(0)
    expect(wheel.push(-30, 0, 1000)).toBe(0)
    expect(wheel.push(30, 0, 1010)).toBe(0)
    expect(wheel.push(0, 0, 1020)).toBe(0)
    expect(wheel.push(20, 0, 1030)).toBe(-1)
  })
})

describe('zoomKey', () => {
  const body = { tagName: 'BODY' }

  it('maps + - 0 on the page', () => {
    expect(zoomKey({ key: '+', shiftKey: true }, body)).toBe('in')
    expect(zoomKey({ key: '=' }, body)).toBe('in')
    expect(zoomKey({ key: '-' }, null)).toBe('out')
    expect(zoomKey({ key: '0' }, { tagName: 'BUTTON' })).toBe('reset')
    expect(zoomKey({ key: 'a' }, body)).toBeNull()
  })

  it('leaves typing and the browser zoom alone', () => {
    expect(zoomKey({ key: '-' }, { tagName: 'TEXTAREA' })).toBeNull()
    expect(zoomKey({ key: '+' }, { tagName: 'INPUT' })).toBeNull()
    expect(zoomKey({ key: '+', ctrlKey: true }, body)).toBeNull()
    expect(zoomKey({ key: '0', metaKey: true }, body)).toBeNull()
    expect(zoomKey({ key: '-', altKey: true }, body)).toBeNull()
    expect(zoomKey({ key: '-', isComposing: true }, body)).toBeNull()
    expect(zoomKey({ key: '-', defaultPrevented: true }, body)).toBeNull()
  })
})

describe('Zoom', () => {
  it('follows the default until the user picks', () => {
    const zoom = new Zoom(MAP, DESKTOP)
    expect(zoom.level).toBe(3)
    expect(zoom.chosen).toBeNull()
    expect(zoom.resize(PHONE)).toBe(true)
    expect(zoom.level).toBe(2)
  })

  it('keeps the pick across resizes, within range', () => {
    const zoom = new Zoom(MAP, DESKTOP)
    expect(zoom.step(1)).toBe(true)
    expect(zoom.level).toBe(4)
    expect(zoom.chosen).toBe(4)
    expect(zoom.step(1)).toBe(false)
    zoom.resize(PHONE)
    expect(zoom.level).toBe(3)
    zoom.resize(view(1920, 1080))
    expect(zoom.level).toBe(4)
  })

  it('starts from a saved pick, clamped', () => {
    expect(new Zoom(MAP, PHONE, 4).level).toBe(3)
    expect(new Zoom(MAP, view(1920, 1080), 1).level).toBe(2)
  })

  it('does not pick when a step goes nowhere', () => {
    const zoom = new Zoom(MAP, view(320, 568))
    expect(zoom.level).toBe(1)
    expect(zoom.step(-1)).toBe(false)
    expect(zoom.chosen).toBeNull()
  })

  it('resets to the default', () => {
    const zoom = new Zoom(MAP, DESKTOP, 1)
    expect(zoom.reset()).toBe(true)
    expect(zoom.chosen).toBeNull()
    expect(zoom.level).toBe(3)
    expect(zoom.reset()).toBe(false)
  })

  it('pinches from the level it started at', () => {
    const zoom = new Zoom(MAP, PHONE)
    expect(zoom.pinch(2)).toBe(false)
    zoom.startPinch()
    expect(zoom.pinching).toBe(true)
    expect(zoom.pinch(1.1)).toBe(false)
    expect(zoom.pinch(1.4)).toBe(true)
    expect(zoom.level).toBe(3)
    expect(zoom.pinch(0.4)).toBe(true)
    expect(zoom.level).toBe(1)
    expect(zoom.pinch(0)).toBe(false)
    zoom.endPinch()
    expect(zoom.pinching).toBe(false)
    expect(zoom.chosen).toBe(1)
  })
})

describe('zoomPrefs', () => {
  function memory(): Storage {
    const data = new Map<string, string>()
    return {
      get length() {
        return data.size
      },
      clear: () => data.clear(),
      getItem: (k) => data.get(k) ?? null,
      key: (i) => [...data.keys()][i] ?? null,
      removeItem: (k) => void data.delete(k),
      setItem: (k, v) => void data.set(k, v),
    }
  }

  it('saves and clears a pick', () => {
    const store = memory()
    const prefs = zoomPrefs(() => store)
    expect(prefs.load()).toBeNull()
    prefs.save(3)
    expect(prefs.load()).toBe(3)
    prefs.save(null)
    expect(prefs.load()).toBeNull()
    expect(store.length).toBe(0)
  })

  it('ignores junk', () => {
    const store = memory()
    const prefs = zoomPrefs(() => store)
    for (const junk of ['0', '5', '2.5', 'abc', '']) {
      store.setItem('vb-office-32.zoom', junk)
      expect(prefs.load()).toBeNull()
    }
  })

  it('survives storage that throws', () => {
    const prefs = zoomPrefs(() => {
      throw new Error('denied')
    })
    expect(prefs.load()).toBeNull()
    expect(() => prefs.save(2)).not.toThrow()
  })
})
