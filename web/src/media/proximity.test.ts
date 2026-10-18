import { describe, expect, it } from 'vitest'
import { distance, nearest, SWAP_MARGIN, volumeAt } from './proximity'

describe('volumeAt', () => {
  it('is full up to 1 tile, falls linearly to 0.2 at 4 and holds there', () => {
    expect(volumeAt(0)).toBe(1)
    expect(volumeAt(1)).toBe(1)
    expect(volumeAt(2.5)).toBeCloseTo(0.6)
    expect(volumeAt(4)).toBeCloseTo(0.2)
    expect(volumeAt(Math.hypot(3, 3))).toBeCloseTo(0.2)
    expect(volumeAt(5)).toBeCloseTo(0.2)
    expect(volumeAt(Infinity)).toBeCloseTo(0.2)
  })

  it('never rises with distance', () => {
    let last = volumeAt(0)
    for (let d = 0; d <= 6; d += 0.25) {
      expect(volumeAt(d)).toBeLessThanOrEqual(last)
      last = volumeAt(d)
    }
  })
})

describe('distance', () => {
  it('is euclidean in tiles', () => {
    expect(distance({ x: 1, y: 1 }, { x: 4, y: 5 })).toBe(5)
  })
})

describe('nearest', () => {
  const d: Record<string, number> = { a: 3, b: 1, c: 2, d: 1, e: 9 }
  const of = (id: string) => d[id] ?? Infinity

  it('keeps the k closest, ties broken by id', () => {
    expect([...nearest(['a', 'b', 'c', 'd', 'e'], of, 3)]).toEqual(['b', 'd', 'c'])
    expect([...nearest(['e', 'd', 'b'], of, 1)]).toEqual(['b'])
  })

  it('returns everyone when there are fewer than k', () => {
    expect(nearest(['a', 'e'], of, 8)).toEqual(new Set(['a', 'e']))
    expect(nearest([], of, 8).size).toBe(0)
  })

  it('keeps the kept ids until someone outside is more than the margin closer', () => {
    const at: Record<string, number> = { a: 1, b: 2, c: 4, x: 4 - SWAP_MARGIN }
    const by = (id: string) => at[id] ?? Infinity
    const kept = new Set(['a', 'b', 'c'])
    expect(nearest(['a', 'b', 'c', 'x'], by, 3)).toEqual(new Set(['a', 'b', 'x']))
    expect(nearest(['a', 'b', 'c', 'x'], by, 3, kept)).toEqual(new Set(['a', 'b', 'c']))
    at.x = 2.9
    expect(nearest(['a', 'b', 'c', 'x'], by, 3, kept)).toEqual(new Set(['a', 'b', 'x']))
  })

  it('stops two players at about the same distance from taking turns', () => {
    const at: Record<string, number> = { a: 1, p: 5, q: 5.4 }
    const by = (id: string) => at[id] ?? Infinity
    let picked = nearest(['a', 'p', 'q'], by, 2)
    expect(picked).toEqual(new Set(['a', 'p']))
    for (const [p, q] of [[5.4, 5], [5, 5.4], [5.6, 5.1]] as const) {
      at.p = p
      at.q = q
      picked = nearest(['a', 'p', 'q'], by, 2, picked)
      expect(picked).toEqual(new Set(['a', 'p']))
    }
  })

  it('fills free places and drops kept ids that are no longer candidates', () => {
    const at: Record<string, number> = { a: 1, b: 9, c: 3 }
    const by = (id: string) => at[id] ?? Infinity
    expect(nearest(['b', 'c'], by, 3, new Set(['a', 'b']))).toEqual(new Set(['c', 'b']))
  })
})
