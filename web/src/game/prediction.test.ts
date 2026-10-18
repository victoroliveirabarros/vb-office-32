import { describe, expect, it } from 'vitest'
import { MAX_PENDING_INPUTS } from '../net/protocol'
import { Grid } from './grid'
import { Predictor, correctionFor } from './prediction'

// 5x1 corridor with a wall at x=3
const grid = new Grid(5, 1, [0, 0, 0, 3, 0])
const start = { x: 0, y: 0, dir: 'down' } as const

describe('Predictor', () => {
  it('applies inputs locally with increasing seq', () => {
    const p = new Predictor(grid, start)
    expect(p.input('right')).toEqual({ seq: 1, dir: 'right' })
    expect(p.input('right')).toEqual({ seq: 2, dir: 'right' })
    expect(p.position).toEqual({ x: 2, y: 0, dir: 'right' })
  })

  it('keeps the prediction when the server agrees', () => {
    const p = new Predictor(grid, start)
    p.input('right')
    p.input('right')
    const result = p.reconcile(2, { x: 2, y: 0, dir: 'right' })
    expect(result).toEqual({ x: 2, y: 0, dir: 'right' })
    expect(p.pendingCount).toBe(0)
    expect(correctionFor({ x: 2, y: 0 }, result)).toBe('none')
  })

  it('corrects to the server when it blocked a move the client predicted', () => {
    const p = new Predictor(grid, start)
    p.input('right')
    const result = p.reconcile(1, { x: 0, y: 0, dir: 'right' })
    expect(result).toEqual({ x: 0, y: 0, dir: 'right' })
    expect(correctionFor({ x: 1, y: 0 }, result)).toBe('tween')
  })

  it('replays inputs not yet acked on top of the authoritative position', () => {
    const p = new Predictor(grid, start)
    p.input('right')
    p.input('right')
    p.input('right')
    expect(p.position).toEqual({ x: 2, y: 0, dir: 'right' })

    const result = p.reconcile(1, { x: 1, y: 0, dir: 'right' })
    expect(p.pendingCount).toBe(2)
    expect(result).toEqual({ x: 2, y: 0, dir: 'right' })
  })

  it('uses the last known authoritative position when state omits the player', () => {
    const p = new Predictor(grid, start)
    p.input('left')
    const result = p.reconcile(1)
    expect(result).toEqual({ x: 0, y: 0, dir: 'down' })
    expect(p.pendingCount).toBe(0)
  })

  it('stops sending and predicting while the server queue may be full', () => {
    const corridor = new Grid(12, 1, new Array<number>(12).fill(0))
    const p = new Predictor(corridor, start)
    const sent = Array.from({ length: 10 }, () => p.input('right')).filter((move) => move !== null)

    expect(sent.map((move) => move.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(p.pendingCount).toBe(MAX_PENDING_INPUTS)
    expect(p.position).toEqual({ x: 8, y: 0, dir: 'right' })

    let shown = p.position
    for (const move of sent) {
      const result = p.reconcile(move.seq, { x: move.seq, y: 0, dir: 'right' })
      expect(correctionFor(shown, result)).toBe('none')
      shown = result
    }
    expect(p.pendingCount).toBe(0)
    expect(p.input('right')).toEqual({ seq: 9, dir: 'right' })
  })

  it('keeps the previous authoritative position across states without the player', () => {
    const p = new Predictor(grid, start)
    p.input('right')
    p.input('right')
    p.reconcile(1, { x: 1, y: 0, dir: 'right' })
    const result = p.reconcile(2)
    expect(result).toEqual({ x: 1, y: 0, dir: 'right' })
  })
})

describe('correctionFor', () => {
  it('snaps when more than one tile apart', () => {
    expect(correctionFor({ x: 0, y: 0 }, { x: 2, y: 0 })).toBe('snap')
    expect(correctionFor({ x: 0, y: 0 }, { x: 1, y: 1 })).toBe('snap')
  })
})
