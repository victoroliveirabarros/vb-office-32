import type { Tile } from '../game/grid'

export const VIDEO_LIMIT = 8

const FULL_VOLUME_DISTANCE = 1
const MIN_VOLUME_DISTANCE = 4
const MIN_VOLUME = 0.2

export function distance(a: Tile, b: Tile): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

// volumeAt is the volume of someone in the nearby set: past 4 tiles (the
// hysteresis band, or a position slightly behind the server's) it stays at
// the minimum until the server drops them from the set.
export function volumeAt(d: number): number {
  if (d <= FULL_VOLUME_DISTANCE) return 1
  if (d >= MIN_VOLUME_DISTANCE) return MIN_VOLUME
  const t = (d - FULL_VOLUME_DISTANCE) / (MIN_VOLUME_DISTANCE - FULL_VOLUME_DISTANCE)
  return 1 - t * (1 - MIN_VOLUME)
}

// nearest picks the k closest ids, ties broken by id so the choice is stable.
export function nearest(ids: Iterable<string>, distanceOf: (id: string) => number, k: number): Set<string> {
  const ranked = [...ids]
    .map((id) => ({ id, d: distanceOf(id) }))
    .sort((a, b) => a.d - b.d || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return new Set(ranked.slice(0, k).map((r) => r.id))
}
