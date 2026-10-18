import { MAX_PENDING_INPUTS } from '../net/protocol'
import type { Dir, MoveInput } from '../net/protocol'
import type { Facing, Grid, Tile } from './grid'

export type Correction = 'none' | 'tween' | 'snap'

export function correctionFor(shown: Tile, target: Tile): Correction {
  const distance = Math.abs(shown.x - target.x) + Math.abs(shown.y - target.y)
  if (distance === 0) return 'none'
  return distance > 1 ? 'snap' : 'tween'
}

export class Predictor {
  private seq = 0
  private pending: MoveInput[] = []
  private authoritative: Facing
  private predicted: Facing

  constructor(
    private readonly grid: Grid,
    start: Facing,
  ) {
    this.authoritative = { ...start }
    this.predicted = { ...start }
  }

  get position(): Facing {
    return this.predicted
  }

  get pendingCount(): number {
    return this.pending.length
  }

  // Returns null when the server's input queue could already be full: a move
  // it would drop must not be predicted either.
  input(dir: Dir): MoveInput | null {
    if (this.pending.length >= MAX_PENDING_INPUTS) return null
    const move = { seq: ++this.seq, dir }
    this.pending.push(move)
    this.predicted = this.grid.move(this.predicted, dir)
    return move
  }

  reconcile(ack: number, server?: Facing): Facing {
    this.pending = this.pending.filter((move) => move.seq > ack)
    if (server) this.authoritative = { x: server.x, y: server.y, dir: server.dir }
    this.predicted = this.pending.reduce((pos, move) => this.grid.move(pos, move.dir), this.authoritative)
    return this.predicted
  }
}
