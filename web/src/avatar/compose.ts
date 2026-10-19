import type { Appearance } from './appearance'
import { FRAME_HEIGHT, FRAME_WIDTH } from './catalog.gen'
import { layerRows, layerSwaps, recolor, rowRect, STRIP_WIDTH } from './frames'

export type MakeCanvas = (width: number, height: number) => HTMLCanvasElement

const makeCanvas: MakeCanvas = (width, height) => {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}

function context(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('2d canvas unavailable')
  ctx.imageSmoothingEnabled = false
  return ctx
}

/**
 * Draws a look into a strip of 12 frames (directions × idle, step A, step
 * B): each layer of the parts atlas, recolored, over the one below.
 */
export function composeStrip(parts: CanvasImageSource, a: Appearance, make: MakeCanvas = makeCanvas): HTMLCanvasElement {
  const out = make(STRIP_WIDTH, FRAME_HEIGHT)
  const ctx = context(out)
  const layer = make(STRIP_WIDTH, FRAME_HEIGHT)
  const lctx = context(layer)
  for (const { layer: name, row } of layerRows(a)) {
    const { x, y, w, h } = rowRect(row)
    lctx.clearRect(0, 0, w, h)
    lctx.drawImage(parts, x, y, w, h, 0, 0, w, h)
    const pixels = lctx.getImageData(0, 0, w, h)
    recolor(pixels.data, layerSwaps(name, a))
    lctx.putImageData(pixels, 0, 0)
    ctx.drawImage(layer, 0, 0)
  }
  return out
}

/** Draws frame of strip into ctx at x, y, scaled. */
export function drawFrame(ctx: CanvasRenderingContext2D, strip: CanvasImageSource, frame: number, x: number, y: number, scale: number): void {
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(strip, frame * FRAME_WIDTH, 0, FRAME_WIDTH, FRAME_HEIGHT, x, y, FRAME_WIDTH * scale, FRAME_HEIGHT * scale)
}
