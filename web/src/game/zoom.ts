import { isComposing, isEditable } from '../chat/keys'
import type { KeyLike, TargetLike } from '../chat/keys'
import { TILE_SIZE } from '../scenes/assets'

export type Size = { width: number; height: number }
export type ZoomRange = { min: number; max: number }
export type Rect = { x: number; y: number; width: number; height: number }
export type Point = { x: number; y: number }

/** The level that fits the whole office on the screen. */
export const OVERVIEW = 'overview'
/** A level the user picked: a whole one, or the overview. */
export type ZoomPick = number | typeof OVERVIEW

export const MAX_ZOOM = 4
// The closest level still shows this many tiles across the short side.
const CLOSEST_TILES = 3.5
// The default is the closest level showing this much of the office around
// the avatar: 3× on a 1280×800 desktop, 2× on a 390×844 phone.
const DEFAULT_LONG_TILES = 12
const DEFAULT_SHORT_TILES = 5.5
const MAX_TEXT_RESOLUTION = 8
// Room the overview leaves around the office, in screen pixels, at most a
// share of the side; more above and below, where the HUD sits.
const FIT_MARGIN_X = 24
const FIT_MARGIN_Y = 48
const FIT_MARGIN_SHARE = 0.05
const MIN_FIT = 0.05

function tilesAcross(px: number, zoom: number): number {
  return px / (zoom * TILE_SIZE)
}

export function clampZoom(zoom: number, range: ZoomRange): number {
  return Math.min(range.max, Math.max(range.min, Math.round(zoom)))
}

/** The largest scale that shows the whole map in `area` with a margin around it. */
export function fitZoom(area: Size, map: Size): number {
  const axis = (areaPx: number, mapPx: number, margin: number) =>
    (areaPx - 2 * Math.min(margin, areaPx * FIT_MARGIN_SHARE)) / mapPx
  return Math.max(MIN_FIT, Math.min(axis(area.width, map.width, FIT_MARGIN_X), axis(area.height, map.height, FIT_MARGIN_Y)))
}

/**
 * The part of the view the overview fits the map in: all of it, or, beside
 * a panel covering some of it, the side of the panel where the map shows
 * largest.
 */
export function freeArea(view: Size, map: Size, covered: Rect | null): Rect {
  const all = { x: 0, y: 0, ...view }
  if (!covered || covered.width <= 0 || covered.height <= 0) return all
  const right = covered.x + covered.width
  const bottom = covered.y + covered.height
  const sides: Rect[] = [
    { x: 0, y: 0, width: covered.x, height: view.height },
    { x: right, y: 0, width: view.width - right, height: view.height },
    { x: 0, y: 0, width: view.width, height: covered.y },
    { x: 0, y: bottom, width: view.width, height: view.height - bottom },
  ].filter((side) => side.width > 0 && side.height > 0)
  let best: Rect | null = null
  for (const side of sides) if (!best || fitZoom(side, map) > fitZoom(best, map)) best = side
  return best ?? all
}

/**
 * The whole levels: from the farthest that does not leave the background
 * showing past the map on both axes to the closest that still shows a few
 * tiles across.
 */
export function zoomRange(view: Size, map: Size): ZoomRange {
  let min = 1
  while (min < MAX_ZOOM && view.width / min > map.width && view.height / min > map.height) min++
  let max = MAX_ZOOM
  while (max > min && tilesAcross(Math.min(view.width, view.height), max) < CLOSEST_TILES) max--
  return { min, max }
}

/**
 * The overview, farther than every whole level: the fit when the map is
 * larger than the free area, else the largest whole level that still fits
 * there, where the pixel art stays crisp.
 */
export function overviewZoom(view: Size, map: Size, covered: Rect | null = null): number {
  const fit = fitZoom(freeArea(view, map, covered), map)
  return fit < 1 ? fit : Math.min(Math.floor(fit), zoomRange(view, map).min - 1)
}

/** Every level from the farthest: the overview, then the whole ones. */
export function zoomLevels(view: Size, map: Size, covered: Rect | null = null): number[] {
  const { min, max } = zoomRange(view, map)
  const levels = [overviewZoom(view, map, covered)]
  for (let zoom = min; zoom <= max; zoom++) levels.push(zoom)
  return levels
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

/** Where the camera centers when it follows `target` at `zoom`, held in its bounds. */
export function followCenter(view: Size, map: Size, zoom: number, target: Point): Point {
  const bounds = cameraBounds(view, map, zoom)
  const axis = (at: number, start: number, length: number, seen: number) =>
    Math.min(start + length - seen / 2, Math.max(start + seen / 2, at))
  return {
    x: axis(target.x, bounds.x, bounds.width, view.width / zoom),
    y: axis(target.y, bounds.y, bounds.height, view.height / zoom),
  }
}

/** Where the camera centers in the overview: the map's middle on the free area's. */
export function overviewCenter(view: Size, map: Size, zoom: number, free: Rect): Point {
  return {
    x: map.width / 2 + (view.width / 2 - (free.x + free.width / 2)) / zoom,
    y: map.height / 2 + (view.height / 2 - (free.y + free.height / 2)) / zoom,
  }
}

/** Canvas text is drawn at the size it shows on screen. */
export function textResolution(zoom: number, dpr: number): number {
  return Math.min(MAX_TEXT_RESOLUTION, Math.max(1, Math.ceil(zoom * dpr)))
}

/**
 * The scale for something drawn at `scale` in the world that should not
 * shrink below `screen` times its size on screen: names, signs and avatars
 * in the overview.
 */
export function keepOnScreen(scale: number, zoom: number, screen = 1): number {
  return Math.max(scale, screen / zoom)
}

// Past the midpoint between levels by this share of the gap before a pinch
// switches, so a pinch held near the midpoint does not flicker. Pinches
// scale, so the levels are compared by their logarithms.
const PINCH_SLACK = 0.1

/** The level a pinch that started at `from` and has scaled by `ratio` asks for. */
export function pinchLevel(from: number, ratio: number, current: number, levels: readonly number[]): number {
  const target = Math.log(from * ratio)
  const edge = (lower: number, upper: number, toward: 1 | -1) => {
    const [a, b] = [Math.log(lower), Math.log(upper)]
    return (a + b) / 2 + toward * PINCH_SLACK * (b - a)
  }
  let i = nearest(levels, current)
  while (i + 1 < levels.length && target > edge(levels[i]!, levels[i + 1]!, 1)) i++
  while (i > 0 && target < edge(levels[i - 1]!, levels[i]!, -1)) i--
  return levels[i]!
}

function nearest(levels: readonly number[], zoom: number): number {
  let best = 0
  levels.forEach((level, i) => {
    if (Math.abs(level - zoom) < Math.abs(levels[best]! - zoom)) best = i
  })
  return best
}

const WHEEL_STEP_PX = 40
const WHEEL_IDLE_MS = 200
// Wheel events further apart than this come from separate notches of a
// mouse; a trackpad sends them every frame.
const NOTCH_GAP_MS = 40
const LINE_PX = 16
const PAGE_PX = 400

/**
 * Turns wheel deltas into level steps. A mouse notch is one step; a
 * trackpad scroll or pinch (many small deltas, then its momentum) is one
 * step per gesture, however long it runs.
 */
export class WheelSteps {
  private sum = 0
  private last = -Infinity
  private stepped = false

  /** 1 zooms in, -1 out, 0 waits for more. */
  push(deltaY: number, deltaMode: number, now: number): -1 | 0 | 1 {
    const px = deltaY * (deltaMode === 1 ? LINE_PX : deltaMode === 2 ? PAGE_PX : 1)
    if (px === 0) return 0
    const gap = now - this.last
    this.last = now
    const notch = Math.abs(px) >= WHEEL_STEP_PX && gap >= NOTCH_GAP_MS
    if (notch || gap > WHEEL_IDLE_MS || Math.sign(px) !== Math.sign(this.sum)) {
      this.sum = 0
      this.stepped = false
    }
    if (this.stepped) return 0
    this.sum += px
    if (Math.abs(this.sum) < WHEEL_STEP_PX) return 0
    const step = this.sum < 0 ? 1 : -1
    this.stepped = true
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
 * which then holds (within what the view allows) across resizes. The
 * overview stays the overview, refitted to each view.
 */
export class Zoom {
  private pinchFrom: number | null = null

  private covered: Rect | null = null

  constructor(
    private readonly map: Size,
    private view: Size,
    private picked: ZoomPick | null = null,
  ) {}

  get levels(): number[] {
    return zoomLevels(this.view, this.map, this.covered)
  }

  get overview(): boolean {
    return this.picked === OVERVIEW
  }

  /** Where the overview fits the map. */
  get free(): Rect {
    return freeArea(this.view, this.map, this.covered)
  }

  get level(): number {
    if (this.picked === OVERVIEW) return overviewZoom(this.view, this.map, this.covered)
    return clampZoom(this.picked ?? defaultZoom(this.view, this.map), zoomRange(this.view, this.map))
  }

  get canZoomIn(): boolean {
    return this.index < this.levels.length - 1
  }

  get canZoomOut(): boolean {
    return this.index > 0
  }

  /** The user's pick, or null while following the default. */
  get chosen(): ZoomPick | null {
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

  /** A panel now covers this part of the view (null: none). */
  cover(rect: Rect | null): boolean {
    const before = this.level
    this.covered = rect
    return this.level !== before
  }

  step(delta: number): boolean {
    const levels = this.levels
    const i = Math.min(levels.length - 1, Math.max(0, this.index + delta))
    return this.set(i === 0 ? OVERVIEW : levels[i]!)
  }

  set(pick: ZoomPick): boolean {
    const next = pick === OVERVIEW ? OVERVIEW : clampZoom(pick, zoomRange(this.view, this.map))
    if (next === this.current) return false
    this.picked = next
    return true
  }

  /** Forgets the pick, which counts as a change even on the default level. */
  reset(): boolean {
    const picked = this.picked !== null
    this.picked = null
    return picked
  }

  startPinch(): void {
    this.pinchFrom = this.level
  }

  pinch(ratio: number): boolean {
    if (this.pinchFrom === null || !(ratio > 0)) return false
    const levels = this.levels
    const level = pinchLevel(this.pinchFrom, ratio, this.level, levels)
    return this.set(level === levels[0] ? OVERVIEW : level)
  }

  endPinch(): void {
    this.pinchFrom = null
  }

  private get current(): ZoomPick {
    return this.overview ? OVERVIEW : this.level
  }

  private get index(): number {
    return this.overview ? 0 : this.levels.indexOf(this.level)
  }
}

const ZOOM_KEY = 'vb-office-32.zoom'

export type ZoomPrefs = {
  load(): ZoomPick | null
  save(zoom: ZoomPick | null): void
}

// Storage may be missing or throw on access (private mode, blocked site
// data); the zoom then starts at the default.
export function zoomPrefs(storage: () => Storage = () => localStorage): ZoomPrefs {
  return {
    load() {
      try {
        const raw = storage().getItem(ZOOM_KEY)
        if (raw === OVERVIEW) return OVERVIEW
        const saved = Number(raw)
        return raw && Number.isInteger(saved) && saved >= 1 && saved <= MAX_ZOOM ? saved : null
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
