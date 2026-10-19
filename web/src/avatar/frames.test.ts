import { describe, expect, it } from 'vitest'
import { DEFAULT_APPEARANCE } from './appearance'
import { CATEGORIES, DIRECTIONS, FRAME_HEIGHT, FRAME_WIDTH, ROWS } from './catalog.gen'
import partsUrl from '../../public/game/avatar-parts.png?inline'
import { FRAME_COUNT, frameFor, frameIndex, layerRows, layerSwaps, recolor, rowRect, STRIP_WIDTH } from './frames'

describe('atlas layout', () => {
  it('matches avatar-parts.png: 12 frames of 16×24 per row, one row per layer or style', () => {
    // The PNG header holds the width and height, big-endian, at bytes 16 and 20.
    const png = Uint8Array.from(atob(partsUrl.slice(partsUrl.indexOf(',') + 1)), (c) => c.charCodeAt(0))
    const header = new DataView(png.buffer)
    const rows = 3 + ROWS.hair.length + ROWS.acc.filter((r) => r !== null).length
    expect(partsUrl.startsWith('data:image/png;base64,')).toBe(true)
    expect(header.getUint32(16)).toBe(STRIP_WIDTH)
    expect(header.getUint32(20)).toBe(rows * FRAME_HEIGHT)
    expect(STRIP_WIDTH).toBe(FRAME_COUNT * FRAME_WIDTH)
    expect(FRAME_COUNT).toBe(12)
  })

  it('numbers frames by direction, then idle, step A, step B', () => {
    expect(DIRECTIONS).toEqual(['down', 'left', 'right', 'up'])
    expect(frameIndex('down', 0)).toBe(0)
    expect(frameIndex('left', 1)).toBe(4)
    expect(frameIndex('right', 2)).toBe(8)
    expect(frameIndex('up', 0)).toBe(9)
    expect(rowRect(4)).toEqual({ x: 0, y: 96, w: 192, h: 24 })
  })

  it('stacks body, pants, shirt, hair and the accessory', () => {
    expect(layerRows(DEFAULT_APPEARANCE)).toEqual([
      { layer: 'body', row: 0 },
      { layer: 'pants', row: 1 },
      { layer: 'shirt', row: 2 },
      { layer: 'hair', row: 3 },
    ])
    expect(layerRows({ ...DEFAULT_APPEARANCE, hair: 5, acc: 3 }).slice(3)).toEqual([
      { layer: 'hair', row: 8 },
      { layer: 'acc', row: 11 },
    ])
  })
})

describe('frameFor', () => {
  it('shows a foot forward in the first half of the step and stands in the second', () => {
    expect(frameFor('down', 0, 0)).toBe(1)
    expect(frameFor('down', 0, 0.49)).toBe(1)
    expect(frameFor('down', 0, 0.5)).toBe(0)
    expect(frameFor('down', 0, 1)).toBe(0)
  })

  it('alternates the foot by stride: A, idle, B, idle', () => {
    const walk = [0, 0.5, 0, 0.5].map((p, i) => frameFor('right', Math.floor(i / 2), p))
    expect(walk).toEqual([7, 6, 8, 6])
    expect(frameFor('up', 3, 0.2)).toBe(11)
    expect(frameFor('left', 4, 0.2)).toBe(4)
  })

  it('stands outside a step', () => {
    expect(frameFor('up', 1, -0.1)).toBe(9)
    expect(frameFor('up', 1, Number.NaN)).toBe(9)
  })
})

describe('recolor', () => {
  const px = (...colors: [number, number, number, number][]) => new Uint8ClampedArray(colors.flat())

  it('swaps exact opaque key colors only', () => {
    const data = px([0xed, 0xbe, 0x9a, 255], [0xed, 0xbe, 0x9a, 128], [0xed, 0xbe, 0x9b, 255], [0, 0, 0, 0x40])
    recolor(data, new Map([[0xedbe9a, 0x583621]]))
    expect([...data]).toEqual([0x58, 0x36, 0x21, 255, 0xed, 0xbe, 0x9a, 128, 0xed, 0xbe, 0x9b, 255, 0, 0, 0, 0x40])
  })

  it('does not chain swaps', () => {
    const data = px([1, 1, 1, 255], [2, 2, 2, 255])
    recolor(data, new Map([[0x010101, 0x020202], [0x020202, 0x030303]]))
    expect([...data]).toEqual([2, 2, 2, 255, 3, 3, 3, 255])
  })
})

describe('layerSwaps', () => {
  it('maps the keys of each recolored category to the chosen option', () => {
    const look = { ...DEFAULT_APPEARANCE, skin: 4, shirt: 1 }
    const shirt = layerSwaps('shirt', look)
    expect(shirt.get(0x1f3c5a)).toBe(0xfdc339)
    expect(shirt.get(0xedbe9a)).toBe(0x583621)
    expect(shirt.size).toBe(6)
    expect(layerSwaps('acc', look).size).toBe(0)
    expect(layerSwaps('pants', { ...look, pants: 2 })).toEqual(new Map([[0x4a6a99, 0xc4ae82], [0x344e75, 0x9e8a62]]))
  })

  it('keeps the keys for the first option', () => {
    const body = layerSwaps('body', DEFAULT_APPEARANCE)
    const keys = CATEGORIES[0]?.options[0]?.colors.map((c) => parseInt(c, 16)) ?? []
    expect([...body.entries()]).toEqual(keys.map((k) => [k, k]))
  })
})
