import { isComposing, isEditable } from '../chat/keys'
import type { KeyLike, TargetLike } from '../chat/keys'
import { TILE_SIZE } from '../scenes/assets'

export type Size = { width: number; height: number }
export type ZoomRange = { min: number; max: number }
export type Rect = { x: number; y: number; width: number; height: number }

export const MAX_ZOOM = 4
// The closest level still shows this many tiles across the short side.
const CLOSEST_TILES = 3.5
// The default is the closest level showing this much of the office around
// the avatar: 3× on a 1280×800 desktop, 2× on a 390×844 phone.
const DEFAULT_LONG_TILES = 12
const DEFAULT_SHORT_TILES = 5.5
const MAX_TEXT_RESOLUTION = 8

function tilesAcross(px: number, zoom: number): number {
  return px / (zoom * TILE_SIZE)
}

export function clampZoom(zoom: number, range: ZoomRange): number {
  return Math.min(range.max, Math.max(range.min, Math.round(zoom)))
}

/**
 * The farthest level leaves the background showing past the map on one axis
 * at most; the closest still shows a few tiles across.
 */
export function zoomRange(view: Size, map: Size): ZoomRange {
  let min = 1
  while (min < MAX_ZOOM && view.width / min > map.width && view.height / min > map.height) min++
  let max = MAX_ZOOM
  while (max > min && tilesAcross(Math.min(view.width, view.height), max) < CLOSEST_TILES) max--
  return { min, max }
}

export function defaultZoom(view: Size, map: Size): number {
  const { min, max } = zoomRange(view, map)
  const long = Math.max(view.width, view.height)
  const short = Math.min(view.width, view.height)
  for (let zoom = max; zoom > min; zoom--) {
    if (tilesAcross(long, zoom) >= DEFAULT_LONG_TILES && tilesAcross(short, zoom) >= DEFAULT_SHORT_TILES) return zoom
  }
  return min
}

/** Where the camera may look: the map, centered when the view is larger. */
export function cameraBounds(view: Size, map: Size, zoom: number): Rect {
  const axis = (viewPx: number, mapPx: number): [number, number] => {
    const seen = viewPx / zoom
    return seen > mapPx ? [(mapPx - seen) / 2, seen] : [0, mapPx]
  }
  const [x, width] = axis(view.width, map.width)
  const [y, height] = axis(view.height, map.height)
  return { x, y, width, height }
}

/** Canvas text is drawn at the size it shows on screen. */
export function textResolution(zoom: number, dpr: number): number {
  return Math.min(MAX_TEXT_RESOLUTION, Math.max(1, Math.ceil(zoom * dpr)))
}

// Past the midpoint between levels by this much before a pinch switches,
// so a pinch held near the midpoint does not flicker.
const PINCH_SLACK = 0.1

/** The level a pinch that started at `from` and has scaled by `ratio` asks for. */
export function pinchLevel(from: number, ratio: number, current: number, range: ZoomRange): number {
  const target = from * ratio
  if (Math.abs(target - current) < 0.5 + PINCH_SLACK) return current
  return clampZoom(target, range)
}

const WHEEL_STEP_PX = 40
const WHEEL_IDLE_MS = 300
const LINE_PX = 16
const PAGE_PX = 400

/**
 * Turns Ctrl+wheel deltas into level steps: a mouse notch is one step, a
 * trackpad pinch (many small deltas) one step per WHEEL_STEP_PX.
 */
export class WheelSteps {
  private sum = 0
  private last = -Infinity

  /** 1 zooms in, -1 out, 0 waits for more. */
  push(deltaY: number, deltaMode: number, now: number): -1 | 0 | 1 {
    const px = deltaY * (deltaMode === 1 ? LINE_PX : deltaMode === 2 ? PAGE_PX : 1)
    if (px === 0) return 0
    if (now - this.last > WHEEL_IDLE_MS || Math.sign(px) !== Math.sign(this.sum)) this.sum = 0
    this.last = now
    this.sum += px
    if (Math.abs(this.sum) < WHEEL_STEP_PX) return 0
    const step = this.sum < 0 ? 1 : -1
    this.sum = 0
    return step
  }
}

export type ZoomKey = 'in' | 'out' | 'reset'

/** +/= zoom in, - out, 0 back to the default; Ctrl/⌘ combos stay the browser's. */
export function zoomKey(e: KeyLike, target: TargetLike): ZoomKey | null {
  if (e.defaultPrevented || isComposing(e) || e.ctrlKey || e.metaKey || e.altKey || isEditable(target)) return null
  switch (e.key) {
    case '+':
    case '=':
      return 'in'
    case '-':
      return 'out'
    case '0':
      return 'reset'
    default:
      return null
  }
}

/**
 * The camera's level: the default for the view until the user picks one,
 * which then holds (within what the view allows) across resizes.
 */
export class Zoom {
  private pinchFrom: number | null = null

  constructor(
    private readonly map: Size,
    private view: Size,
    private picked: number | null = null,
  ) {}

  get range(): ZoomRange {
    return zoomRange(this.view, this.map)
  }

  get level(): number {
    return clampZoom(this.picked ?? defaultZoom(this.view, this.map), this.range)
  }

  /** The user's pick, or null while following the default. */
  get chosen(): number | null {
    return this.picked
  }

  get pinching(): boolean {
    return this.pinchFrom !== null
  }

  /** Each method reports whether the level changed. */
  resize(view: Size): boolean {
    const before = this.level
    this.view = view
    return this.level !== before
  }

  step(delta: number): boolean {
    return this.set(this.level + delta)
  }

  set(zoom: number): boolean {
    const next = clampZoom(zoom, this.range)
    if (next === this.level) return false
    this.picked = next
    return true
  }

  reset(): boolean {
    const before = this.level
    this.picked = null
    return this.level !== before
  }

  startPinch(): void {
    this.pinchFrom = this.level
  }

  pinch(ratio: number): boolean {
    if (this.pinchFrom === null || !(ratio > 0)) return false
    return this.set(pinchLevel(this.pinchFrom, ratio, this.level, this.range))
  }

  endPinch(): void {
    this.pinchFrom = null
  }
}

const ZOOM_KEY = 'vb-office-32.zoom'

export type ZoomPrefs = {
  load(): number | null
  save(zoom: number | null): void
}

// Storage may be missing or throw on access (private mode, blocked site
// data); the zoom then starts at the default.
export function zoomPrefs(storage: () => Storage = () => localStorage): ZoomPrefs {
  return {
    load() {
      try {
        const saved = Number(storage().getItem(ZOOM_KEY))
        return Number.isInteger(saved) && saved >= 1 && saved <= MAX_ZOOM ? saved : null
      } catch {
        return null
      }
    },
    save(zoom) {
      try {
        if (zoom === null) storage().removeItem(ZOOM_KEY)
        else storage().setItem(ZOOM_KEY, String(zoom))
      } catch {
        // see above
      }
    },
  }
}
