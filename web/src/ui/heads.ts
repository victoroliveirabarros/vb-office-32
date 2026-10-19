import { formatAppearance } from '../avatar/appearance'
import type { Appearance } from '../avatar/appearance'
import { FRAME_WIDTH } from '../avatar/catalog.gen'
import { composeStrip } from '../avatar/compose'
import { frameIndex } from '../avatar/frames'
import { loadParts } from '../avatar/parts'

// Head and shoulders: the top rows of the idle front frame.
export const HEAD_ROWS = 16
const CACHE = 64

export type Heads = {
  /** A small canvas for a head, drawn now or once the parts load. */
  create(className: string): HTMLCanvasElement
  draw(canvas: HTMLCanvasElement, look: Appearance): void
}

/** Draws avatars' heads, as the map shows them, for the panels and the profile. */
export function createHeads(): Heads {
  let parts: HTMLImageElement | null = null
  const strips = new Map<string, HTMLCanvasElement>()
  const waiting = new Map<HTMLCanvasElement, Appearance>()
  const shown = new WeakMap<HTMLCanvasElement, string>()

  const strip = (img: HTMLImageElement, look: Appearance) => {
    const key = formatAppearance(look)
    let s = strips.get(key)
    if (!s) {
      if (strips.size >= CACHE) strips.clear()
      s = composeStrip(img, look)
      strips.set(key, s)
    }
    return s
  }

  const paint = (canvas: HTMLCanvasElement, look: Appearance) => {
    const key = formatAppearance(look)
    if (!parts) {
      waiting.set(canvas, look)
      return
    }
    if (shown.get(canvas) === key) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    shown.set(canvas, key)
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.imageSmoothingEnabled = false
    ctx.drawImage(strip(parts, look), frameIndex('down', 0) * FRAME_WIDTH, 0, FRAME_WIDTH, HEAD_ROWS, 0, 0, FRAME_WIDTH, HEAD_ROWS)
  }

  void loadParts().then(
    (img) => {
      parts = img
      for (const [canvas, look] of waiting) paint(canvas, look)
      waiting.clear()
    },
    () => undefined,
  )

  return {
    create(className) {
      const canvas = document.createElement('canvas')
      canvas.className = className
      canvas.width = FRAME_WIDTH
      canvas.height = HEAD_ROWS
      canvas.setAttribute('aria-hidden', 'true')
      return canvas
    },
    draw: paint,
  }
}
