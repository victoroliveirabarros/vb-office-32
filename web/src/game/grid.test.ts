import { describe, expect, it } from 'vitest'
import { Grid } from './grid'

const tiled = {
  width: 3,
  height: 2,
  layers: [
    { name: 'floor', type: 'tilelayer', data: [1, 1, 1, 1, 1, 1] },
    { name: 'walls', type: 'tilelayer', data: [0, 3, 0, 0, 0, 0] },
    { name: 'decor', type: 'tilelayer', data: [7, 7, 0, 7, 0, 0] },
    { name: 'spawns', type: 'objectgroup', objects: [] },
  ],
}

describe('Grid', () => {
  const grid = Grid.fromTiled(tiled)

  it('blocks tiles with a non-zero walls gid', () => {
    expect(grid.isBlocked(1, 0)).toBe(true)
    expect(grid.isBlocked(0, 0)).toBe(false)
  })

  it('ignores the decor layer', () => {
    expect(grid.isBlocked(0, 0)).toBe(false)
    expect(grid.isBlocked(0, 1)).toBe(false)
  })

  it('blocks outside the map', () => {
    expect(grid.isBlocked(-1, 0)).toBe(true)
    expect(grid.isBlocked(0, -1)).toBe(true)
    expect(grid.isBlocked(3, 0)).toBe(true)
    expect(grid.isBlocked(0, 2)).toBe(true)
  })

  it('moves into free tiles', () => {
    expect(grid.move({ x: 0, y: 0, dir: 'up' }, 'down')).toEqual({ x: 0, y: 1, dir: 'down' })
  })

  it('only turns when the destination is blocked', () => {
    expect(grid.move({ x: 0, y: 0, dir: 'down' }, 'right')).toEqual({ x: 0, y: 0, dir: 'right' })
    expect(grid.move({ x: 0, y: 0, dir: 'down' }, 'left')).toEqual({ x: 0, y: 0, dir: 'left' })
  })

  it('only turns when the gate refuses the step', () => {
    const gate = (from: { x: number; y: number }, to: { x: number; y: number }) => !(from.y === 0 && to.y === 1)
    expect(grid.move({ x: 0, y: 0, dir: 'up' }, 'down', gate)).toEqual({ x: 0, y: 0, dir: 'down' })
    expect(grid.move({ x: 0, y: 1, dir: 'up' }, 'right', gate)).toEqual({ x: 1, y: 1, dir: 'right' })
  })

  it('rejects maps without a valid walls layer', () => {
    expect(() => Grid.fromTiled({ width: 3, height: 2, layers: [] })).toThrow()
    expect(() => Grid.fromTiled({ width: 3, height: 2, layers: [{ name: 'walls', type: 'tilelayer', data: [0] }] })).toThrow()
    expect(() => Grid.fromTiled(null)).toThrow()
  })
})
