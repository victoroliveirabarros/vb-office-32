import type { Dir } from '../net/protocol'
import { CATEGORIES, DIRECTIONS, FRAME_HEIGHT, FRAME_WIDTH, FRAMES_PER_DIRECTION, LAYER_RECOLORS, ROWS } from './catalog.gen'
import type { Field } from './catalog.gen'
import type { Appearance } from './appearance'

export const STRIP_WIDTH = FRAME_WIDTH * DIRECTIONS.length * FRAMES_PER_DIRECTION
export const FRAME_COUNT = DIRECTIONS.length * FRAMES_PER_DIRECTION

const IDLE = 0
const STEP_A = 1
const STEP_B = 2

/** The column of a strip, and of the parts atlas, for dir at pose. */
export function frameIndex(dir: Dir, pose: number): number {
  return DIRECTIONS.indexOf(dir) * FRAMES_PER_DIRECTION + pose
}

/**
 * The frame of a step in progress (0 to 1): the first half shows a foot
 * forward, the second stands; stride alternates the foot, so walking reads
 * A, idle, B, idle.
 */
export function frameFor(dir: Dir, stride: number, progress: number): number {
  if (!(progress >= 0 && progress < 0.5)) return frameIndex(dir, IDLE)
  return frameIndex(dir, stride % 2 === 0 ? STEP_A : STEP_B)
}

export type Layer = keyof typeof ROWS

export type LayerRow = { layer: Layer; row: number }

/** The rows of the parts atlas that make up a look, bottom to top. */
export function layerRows(a: Appearance): LayerRow[] {
  const rows: LayerRow[] = [
    { layer: 'body', row: ROWS.body },
    { layer: 'pants', row: ROWS.pants },
    { layer: 'shirt', row: ROWS.shirt },
  ]
  const hair = ROWS.hair[a.hair]
  if (hair !== undefined) rows.push({ layer: 'hair', row: hair })
  const acc = ROWS.acc[a.acc]
  if (acc != null) rows.push({ layer: 'acc', row: acc })
  return rows
}

/** Where a row of the parts atlas is: the whole strip of 12 frames. */
export function rowRect(row: number): { x: number; y: number; w: number; h: number } {
  return { x: 0, y: row * FRAME_HEIGHT, w: STRIP_WIDTH, h: FRAME_HEIGHT }
}

const hex = (s: string) => parseInt(s, 16)

/** Key color to color, as 0xrrggbb, for one layer of a look. */
export function layerSwaps(layer: Layer, a: Appearance): Map<number, number> {
  const swaps = new Map<number, number>()
  for (const field of LAYER_RECOLORS[layer]) {
    const cat = CATEGORIES.find((c) => c.field === field)
    const keys = cat?.options[0]?.colors ?? []
    const colors = cat?.options[a[field as Field]]?.colors ?? keys
    keys.forEach((key, i) => {
      const to = colors[i]
      if (to !== undefined) swaps.set(hex(key), hex(to))
    })
  }
  return swaps
}

/** Swaps exact opaque key colors in RGBA pixels, in place. */
export function recolor(data: Uint8ClampedArray, swaps: ReadonlyMap<number, number>): void {
  if (swaps.size === 0) return
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] !== 255) continue
    const to = swaps.get(((data[i] ?? 0) << 16) | ((data[i + 1] ?? 0) << 8) | (data[i + 2] ?? 0))
    if (to === undefined) continue
    data[i] = (to >> 16) & 0xff
    data[i + 1] = (to >> 8) & 0xff
    data[i + 2] = to & 0xff
  }
}
