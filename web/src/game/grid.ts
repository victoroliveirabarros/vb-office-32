import { isInt, isRecord } from '../guards'
import type { Dir } from '../net/protocol'

export type Tile = { x: number; y: number }
export type Facing = Tile & { dir: Dir }

const OFFSETS: Record<Dir, Tile> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
}

export class Grid {
  constructor(
    readonly width: number,
    readonly height: number,
    private readonly walls: readonly number[],
  ) {
    if (walls.length !== width * height) {
      throw new Error(`walls layer has ${walls.length} tiles, expected ${width * height}`)
    }
  }

  static fromTiled(map: unknown): Grid {
    if (!isRecord(map) || !isInt(map.width) || !isInt(map.height) || !Array.isArray(map.layers)) {
      throw new Error('invalid Tiled map')
    }
    const walls = map.layers.find((l: unknown) => isRecord(l) && l.name === 'walls' && l.type === 'tilelayer')
    if (!isRecord(walls) || !Array.isArray(walls.data) || !walls.data.every(isInt)) {
      throw new Error('Tiled map has no finite "walls" tile layer')
    }
    return new Grid(map.width, map.height, walls.data)
  }

  isBlocked(x: number, y: number): boolean {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return true
    return this.walls[y * this.width + x] !== 0
  }

  move(from: Facing, dir: Dir): Facing {
    const offset = OFFSETS[dir]
    const x = from.x + offset.x
    const y = from.y + offset.y
    return this.isBlocked(x, y) ? { x: from.x, y: from.y, dir } : { x, y, dir }
  }
}
