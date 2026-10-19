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

// A kept id gives its place only to one more than this many tiles closer.
export const SWAP_MARGIN = 1

type Ranked = { id: string; d: number }

const byDistance = (a: Ranked, b: Ranked) => a.d - b.d || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

// nearest picks the k closest ids, ties broken by id so the choice is stable.
// Ids in kept stay picked until someone outside is more than SWAP_MARGIN
// closer, so two players at about the same distance do not take turns.
export function nearest(
  ids: Iterable<string>,
  distanceOf: (id: string) => number,
  k: number,
  kept: ReadonlySet<string> = new Set(),
): Set<string> {
  const ranked = [...ids].map((id) => ({ id, d: distanceOf(id) })).sort(byDistance)
  const picked = ranked.filter((r) => kept.has(r.id)).slice(0, k)
  for (const r of ranked) {
    if (kept.has(r.id)) continue
    picked.sort(byDistance)
    const worst = picked.at(-1)
    if (picked.length < k) picked.push(r)
    else if (worst && r.d + SWAP_MARGIN < worst.d) picked[picked.length - 1] = r
    else break
  }
  return new Set(picked.sort(byDistance).map((r) => r.id))
}
