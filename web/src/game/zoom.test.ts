import { describe, expect, it } from 'vitest'
import {
  cameraBounds,
  clampZoom,
  defaultZoom,
  fitZoom,
  followCenter,
  freeArea,
  keepOnScreen,
  OVERVIEW,
  overviewCenter,
  overviewZoom,
  pinchLevel,
  textResolution,
  WheelSteps,
  Zoom,
  zoomKey,
  zoomLevels,
  zoomPrefs,
  zoomRange,
} from './zoom'

// The office: 50×25 tiles of 32 px.
const MAP = { width: 1600, height: 800 }
const DESKTOP = { width: 1280, height: 800 }
const PHONE = { width: 390, height: 844 }
const view = (width: number, height: number) => ({ width, height })

describe('fitZoom', () => {
  it('fits the whole map with a small margin', () => {
    expect(fitZoom(DESKTOP, MAP)).toBeCloseTo(0.77)
    expect(fitZoom(PHONE, MAP)).toBeCloseTo(0.2194, 4)
    expect(fitZoom(view(1920, 1080), MAP)).toBeCloseTo(1.17)
    expect(fitZoom(view(1600, 900), MAP)).toBeCloseTo(0.97)
  })

  it('takes the tighter axis', () => {
    // Wide and short: the height limits, with more room for the HUD.
    expect(fitZoom(view(1600, 600), MAP)).toBeCloseTo(0.675)
    expect(fitZoom(view(844, 390), MAP)).toBeCloseTo(0.4387, 4)
  })

  it('stays positive on empty views', () => {
    expect(fitZoom(view(0, 0), MAP)).toBeGreaterThan(0)
  })
})

// The chat panel, open by default on a desktop.
const CHAT = { x: 904, y: 304, width: 360, height: 480 }
// On a phone it rises over the bottom of the screen.
const PHONE_CHAT = { x: 16, y: 340, width: 358, height: 420 }

describe('freeArea', () => {
  it('is the whole view with nothing covering it', () => {
    expect(freeArea(DESKTOP, MAP, null)).toEqual({ x: 0, y: 0, width: 1280, height: 800 })
    expect(freeArea(DESKTOP, MAP, { x: 0, y: 0, width: 0, height: 0 })).toEqual({ x: 0, y: 0, width: 1280, height: 800 })
  })

  it('is the side of a panel where the map shows largest', () => {
    expect(freeArea(DESKTOP, MAP, CHAT)).toEqual({ x: 0, y: 0, width: 904, height: 800 })
    expect(freeArea(PHONE, MAP, PHONE_CHAT)).toEqual({ x: 0, y: 0, width: 390, height: 340 })
  })
})

describe('overviewZoom', () => {
  it('fits beside a panel', () => {
    expect(overviewZoom(DESKTOP, MAP, CHAT)).toBeCloseTo(0.535)
    expect(overviewZoom(PHONE, MAP, PHONE_CHAT)).toBeCloseTo(0.22, 2)
    expect(overviewZoom(view(1920, 1080), MAP, { x: 1544, y: 544, width: 360, height: 520 })).toBeCloseTo(0.935)
  })

  it('is the fit when the map is larger than the screen', () => {
    expect(overviewZoom(DESKTOP, MAP)).toBeCloseTo(0.77)
    expect(overviewZoom(PHONE, MAP)).toBeCloseTo(0.22, 2)
  })

  it('is a whole level once one fits', () => {
    expect(overviewZoom(view(1920, 1080), MAP)).toBe(1)
    expect(overviewZoom(view(3840, 2160), MAP)).toBe(2)
    expect(overviewZoom(view(20000, 10000), MAP)).toBe(3)
  })
})

describe('zoomRange', () => {
  it('goes from past the overview to a few tiles across', () => {
    expect(zoomRange(DESKTOP, MAP)).toEqual({ min: 1, max: 4 })
    expect(zoomRange(PHONE, MAP)).toEqual({ min: 1, max: 3 })
    expect(zoomRange(view(360, 640), MAP)).toEqual({ min: 1, max: 3 })
    expect(zoomRange(view(320, 568), MAP)).toEqual({ min: 1, max: 2 })
  })

  it('starts past a whole overview', () => {
    expect(zoomRange(view(1920, 1080), MAP)).toEqual({ min: 2, max: 4 })
    expect(zoomRange(view(3840, 2160), MAP)).toEqual({ min: 3, max: 4 })
    expect(zoomRange(view(1600, 900), MAP).min).toBe(1)
  })

  it('never inverts on tiny views', () => {
    expect(zoomRange(view(100, 100), MAP)).toEqual({ min: 1, max: 1 })
    expect(zoomRange(view(0, 0), MAP)).toEqual({ min: 1, max: 1 })
  })
})

describe('zoomLevels', () => {
  it('puts the overview before the whole levels', () => {
    const desktop = zoomLevels(DESKTOP, MAP)
    expect(desktop[0]).toBeCloseTo(0.77)
    expect(desktop.slice(1)).toEqual([1, 2, 3, 4])
    const phone = zoomLevels(PHONE, MAP)
    expect(phone[0]).toBeCloseTo(0.22, 2)
    expect(phone.slice(1)).toEqual([1, 2, 3])
    expect(zoomLevels(view(1920, 1080), MAP)).toEqual([1, 2, 3, 4])
    expect(zoomLevels(view(3840, 2160), MAP)).toEqual([2, 3, 4])
  })

  it('always climbs', () => {
    for (const v of [DESKTOP, PHONE, view(1920, 1080), view(1600, 900), view(100, 100), view(0, 0), view(20000, 10000)]) {
      const levels = zoomLevels(v, MAP)
      for (let i = 1; i < levels.length; i++) expect(levels[i]).toBeGreaterThan(levels[i - 1]!)
    }
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

  it('pins the camera on the middle of the office in the overview', () => {
    const zoom = overviewZoom(DESKTOP, MAP)
    const { x, y, width, height } = cameraBounds(DESKTOP, MAP, zoom)
    expect(width).toBeCloseTo(1280 / zoom)
    expect(height).toBeCloseTo(800 / zoom)
    expect(x + width / 2).toBeCloseTo(800)
    expect(y + height / 2).toBeCloseTo(400)
  })
})

describe('followCenter', () => {
  it('is the target when the bounds allow', () => {
    expect(followCenter(DESKTOP, MAP, 2, { x: 464, y: 368 })).toEqual({ x: 464, y: 368 })
  })

  it('holds the view in the map', () => {
    expect(followCenter(DESKTOP, MAP, 1, { x: 100, y: 700 })).toEqual({ x: 640, y: 400 })
    expect(followCenter(DESKTOP, MAP, 3, { x: 1590, y: 10 })).toEqual({ x: 1600 - 1280 / 6, y: 800 / 6 })
  })

  it('centers the map on an axis the view is larger on', () => {
    expect(followCenter(PHONE, MAP, 1, { x: 300, y: 10 })).toEqual({ x: 300, y: 400 })
  })
})

describe('overviewCenter', () => {
  it('puts the middle of the map on the middle of the view', () => {
    expect(overviewCenter(DESKTOP, MAP, 0.77, { x: 0, y: 0, ...DESKTOP })).toEqual({ x: 800, y: 400 })
  })

  it('or on the middle of the free area', () => {
    const { x, y } = overviewCenter(DESKTOP, MAP, 0.5, { x: 0, y: 0, width: 904, height: 800 })
    // The view's middle is 188 screen px right of the free area's: 376 map px.
    expect(x).toBeCloseTo(800 + 376)
    expect(y).toBe(400)
  })
})

describe('keepOnScreen', () => {
  it('keeps the world scale from 1× up', () => {
    expect(keepOnScreen(1, 1)).toBe(1)
    expect(keepOnScreen(2, 3)).toBe(2)
  })

  it('grows below 1× to hold the size on screen', () => {
    expect(keepOnScreen(1, 0.5)).toBe(2)
    expect(keepOnScreen(2, 0.77)).toBe(2)
    expect(keepOnScreen(2, 0.25)).toBe(4)
    expect(keepOnScreen(1, 0.25, 0.5)).toBe(2)
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
  const levels = [1, 2, 3, 4]

  it('scales the starting level by the pinch', () => {
    expect(pinchLevel(2, 1, 2, levels)).toBe(2)
    expect(pinchLevel(2, 1.5, 2, levels)).toBe(3)
    expect(pinchLevel(2, 2, 2, levels)).toBe(4)
    expect(pinchLevel(3, 0.5, 3, levels)).toBe(2)
    expect(pinchLevel(3, 0.3, 3, levels)).toBe(1)
  })

  it('holds near the midpoint between levels', () => {
    expect(pinchLevel(2, 1.25, 2, levels)).toBe(2)
    expect(pinchLevel(2, 1.29, 2, levels)).toBe(3)
    // Back from 3: only once clearly under the midpoint.
    expect(pinchLevel(2, 1.2, 3, levels)).toBe(3)
    expect(pinchLevel(2, 1.15, 3, levels)).toBe(2)
  })

  it('stays in range', () => {
    expect(pinchLevel(4, 3, 4, levels)).toBe(4)
    expect(pinchLevel(1, 0.1, 1, levels)).toBe(1)
  })

  it('reaches the overview and back', () => {
    const phone = [0.22, 1, 2, 3]
    expect(pinchLevel(1, 0.6, 1, phone)).toBe(1)
    expect(pinchLevel(1, 0.4, 1, phone)).toBe(0.22)
    expect(pinchLevel(2, 0.15, 2, phone)).toBe(0.22)
    expect(pinchLevel(0.22, 2, 0.22, phone)).toBe(0.22)
    expect(pinchLevel(0.22, 2.6, 0.22, phone)).toBe(1)
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

  it('takes one step per trackpad gesture, momentum included', () => {
    const wheel = new WheelSteps()
    const deltas = [...Array(10).fill(-8), ...Array(40).fill(-30), ...Array(20).fill(-2)]
    const steps = deltas.map((dy, i) => wheel.push(dy, 0, i * 16))
    expect(steps.filter((s) => s === 1)).toHaveLength(1)
    expect(steps.filter((s) => s === -1)).toHaveLength(0)
    // The next gesture steps again.
    const later = [-8, -8, -8, -8, -8].map((dy, i) => wheel.push(dy, 0, 2000 + i * 16))
    expect(later.filter((s) => s === 1)).toHaveLength(1)
  })

  it('steps once for a fast spin of the wheel', () => {
    const wheel = new WheelSteps()
    const steps = [0, 10, 20, 30].map((t) => wheel.push(100, 0, t))
    expect(steps).toEqual([-1, 0, 0, 0])
  })

  it('turns back at once', () => {
    const wheel = new WheelSteps()
    expect([-8, -8, -8, -8, -8].map((dy, i) => wheel.push(dy, 0, i * 16))).toContain(1)
    expect([8, 8, 8, 8, 8].map((dy, i) => wheel.push(dy, 0, 100 + i * 16))).toContain(-1)
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
    expect(zoom.overview).toBe(false)
    expect(zoom.resize(PHONE)).toBe(true)
    expect(zoom.level).toBe(2)
  })

  it('keeps the pick across resizes, within range', () => {
    const zoom = new Zoom(MAP, DESKTOP)
    expect(zoom.step(1)).toBe(true)
    expect(zoom.level).toBe(4)
    expect(zoom.chosen).toBe(4)
    expect(zoom.canZoomIn).toBe(false)
    expect(zoom.step(1)).toBe(false)
    zoom.resize(PHONE)
    expect(zoom.level).toBe(3)
    zoom.resize(view(1920, 1080))
    expect(zoom.level).toBe(4)
  })

  it('starts from a saved pick, clamped', () => {
    expect(new Zoom(MAP, PHONE, 4).level).toBe(3)
    expect(new Zoom(MAP, view(1920, 1080), 1).level).toBe(2)
    expect(new Zoom(MAP, view(1920, 1080), 1).overview).toBe(false)
  })

  it('steps out past 1× to the overview, and no further', () => {
    const zoom = new Zoom(MAP, DESKTOP, 1)
    expect(zoom.canZoomOut).toBe(true)
    expect(zoom.step(-1)).toBe(true)
    expect(zoom.overview).toBe(true)
    expect(zoom.chosen).toBe(OVERVIEW)
    expect(zoom.level).toBeCloseTo(0.77)
    expect(zoom.canZoomOut).toBe(false)
    expect(zoom.step(-1)).toBe(false)
    expect(zoom.step(1)).toBe(true)
    expect(zoom.level).toBe(1)
    expect(zoom.overview).toBe(false)
  })

  it('reaches the overview from the default in steps', () => {
    const zoom = new Zoom(MAP, PHONE)
    zoom.step(-1)
    zoom.step(-1)
    expect(zoom.overview).toBe(true)
    expect(zoom.level).toBeCloseTo(0.22, 2)
    const big = new Zoom(MAP, view(1920, 1080))
    for (let i = 0; i < 3; i++) big.step(-1)
    expect(big.overview).toBe(true)
    expect(big.level).toBe(1)
  })

  it('refits the overview to each view', () => {
    const zoom = new Zoom(MAP, DESKTOP, OVERVIEW)
    expect(zoom.level).toBeCloseTo(0.77)
    expect(zoom.resize(PHONE)).toBe(true)
    expect(zoom.overview).toBe(true)
    expect(zoom.level).toBeCloseTo(0.22, 2)
    expect(zoom.resize(view(1920, 1080))).toBe(true)
    expect(zoom.level).toBe(1)
    expect(zoom.resize(view(1920, 1080))).toBe(false)
  })

  it('fits the overview beside a panel, keeping the whole levels', () => {
    const zoom = new Zoom(MAP, DESKTOP, OVERVIEW)
    expect(zoom.cover(CHAT)).toBe(true)
    expect(zoom.level).toBeCloseTo(0.535)
    expect(zoom.free).toEqual({ x: 0, y: 0, width: 904, height: 800 })
    expect(zoom.levels.slice(1)).toEqual([1, 2, 3, 4])
    expect(zoom.cover(null)).toBe(true)
    expect(zoom.level).toBeCloseTo(0.77)
    const picked = new Zoom(MAP, DESKTOP, 2)
    expect(picked.cover(CHAT)).toBe(false)
    expect(picked.level).toBe(2)
  })

  it('does not pick when a step goes nowhere', () => {
    const zoom = new Zoom(MAP, view(320, 568), OVERVIEW)
    expect(zoom.step(-1)).toBe(false)
    expect(zoom.chosen).toBe(OVERVIEW)
    const top = new Zoom(MAP, DESKTOP)
    top.set(4)
    expect(top.set(4)).toBe(false)
  })

  it('resets to the default', () => {
    const zoom = new Zoom(MAP, DESKTOP, OVERVIEW)
    expect(zoom.reset()).toBe(true)
    expect(zoom.chosen).toBeNull()
    expect(zoom.level).toBe(3)
    expect(zoom.reset()).toBe(false)

    const same = new Zoom(MAP, DESKTOP, 3)
    expect(same.reset()).toBe(true)
    expect(same.chosen).toBeNull()
  })

  it('pinches from the level it started at', () => {
    const zoom = new Zoom(MAP, PHONE)
    expect(zoom.pinch(2)).toBe(false)
    zoom.startPinch()
    expect(zoom.pinching).toBe(true)
    expect(zoom.pinch(1.1)).toBe(false)
    expect(zoom.pinch(1.4)).toBe(true)
    expect(zoom.level).toBe(3)
    expect(zoom.pinch(0.6)).toBe(true)
    expect(zoom.level).toBe(1)
    expect(zoom.pinch(0)).toBe(false)
    zoom.endPinch()
    expect(zoom.pinching).toBe(false)
    expect(zoom.chosen).toBe(1)
  })

  it('pinches to the overview and back', () => {
    const zoom = new Zoom(MAP, PHONE, 1)
    zoom.startPinch()
    expect(zoom.pinch(0.3)).toBe(true)
    expect(zoom.overview).toBe(true)
    zoom.endPinch()
    zoom.startPinch()
    expect(zoom.pinch(1.5)).toBe(false)
    expect(zoom.pinch(3)).toBe(true)
    expect(zoom.level).toBe(1)
    zoom.endPinch()
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
    prefs.save(OVERVIEW)
    expect(prefs.load()).toBe(OVERVIEW)
    prefs.save(null)
    expect(prefs.load()).toBeNull()
    expect(store.length).toBe(0)
  })

  it('ignores junk', () => {
    const store = memory()
    const prefs = zoomPrefs(() => store)
    for (const junk of ['0', '5', '2.5', 'abc', '', ' ', 'Overview']) {
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
