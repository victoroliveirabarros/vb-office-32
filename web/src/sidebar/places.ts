import type { Person } from '../chat/roster'
import { deskLabel } from '../game/desks'
import type { Desks } from '../game/desks'
import type { TileRect, ZoneMap } from '../game/zones'
import type { DeskGuest, ZoneKind } from '../net/protocol'

export type PlaceKind = ZoneKind | 'open'

/** A room, or a named part of the open floor, with who is there. */
export type Place = { id: string; name: string; kind: PlaceKind; tiles: TileRect | null; people: Person[]; here: boolean }

/** The open floor: where everyone outside rooms and other areas is. */
export const OPEN_FLOOR = { id: 'escritorio', name: 'Escritório aberto' } as const

/** Where someone is: the room, the part of the open floor, or the open floor. */
export function placeOf(person: Pick<Person, 'room' | 'area'>): { id: string; name: string } {
  return person.room ?? person.area ?? OPEN_FLOOR
}

/**
 * The rooms in map order, then the open floor and the other areas, each
 * with its people in the roster's order. Someone on no named tile (a door)
 * counts on the open floor; the desks are listed apart.
 */
export function places(zones: ZoneMap, people: readonly Person[]): Place[] {
  const open = zones.areaById(OPEN_FLOOR.id)
  const list: Place[] = [
    ...zones.zones
      .filter((z) => z.kind !== 'desk')
      .map((z) => ({ id: z.id, name: z.name, kind: z.kind, tiles: z.tiles, people: [], here: false })),
    { id: OPEN_FLOOR.id, name: open?.name ?? OPEN_FLOOR.name, kind: 'open' as const, tiles: open?.tiles ?? null, people: [], here: false },
    ...zones.areas.filter((a) => a.id !== OPEN_FLOOR.id).map((a) => ({ id: a.id, name: a.name, kind: 'open' as const, tiles: a.tiles, people: [], here: false })),
  ]
  const byId = new Map(list.map((p) => [p.id, p]))
  const openFloor = byId.get(OPEN_FLOOR.id)
  for (const person of people) {
    if (person.room?.kind === 'desk') continue
    const place = byId.get(placeOf(person).id) ?? openFloor
    if (!place) continue
    place.people.push(person)
    if (person.self) place.here = true
  }
  return list
}

export type DeskStatus = 'online' | 'offline' | 'free'

/** A desk: its owner online, offline (then closed to all but the owner) or none; own when it is ours. */
export type DeskPlace = Place & { status: DeskStatus; lockedForMe: boolean; own: boolean }

/** The desks in map order, named after their owners, with who is at each. */
export function deskPlaces(zones: ZoneMap, desks: Pick<Desks, 'get' | 'lockedForMe' | 'mine'>, people: readonly Person[]): DeskPlace[] {
  const own = desks.mine()?.id
  return zones.zones
    .filter((z) => z.kind === 'desk')
    .map((z) => {
      const desk = desks.get(z.id)
      const here = people.filter((p) => p.room?.id === z.id)
      const status: DeskStatus = !desk?.locked ? 'free' : desk.online ? 'online' : 'offline'
      return {
        id: z.id,
        name: deskLabel(z, desk),
        kind: z.kind,
        tiles: z.tiles,
        people: here,
        here: here.some((p) => p.self),
        status,
        lockedForMe: desks.lockedForMe(z.id),
        own: z.id === own,
      }
    })
}

export type DeskGuestRow = { id: string; label: string; online: boolean; status: string; revoke: string }

/** Whom we invited to our desk, online or not, each to be taken back. */
export function deskGuestRows(guests: readonly DeskGuest[], labelFor: (id: string, name: string) => string): DeskGuestRow[] {
  return guests.map((g) => {
    const label = labelFor(g.id, g.name)
    return { id: g.id, label, online: g.online, status: g.online ? 'Online' : 'Offline', revoke: `Remover convite de ${label}` }
  })
}

const STATUS_TEXT: Record<DeskStatus, string> = { online: 'Online', offline: 'Offline · fechada', free: 'Livre' }

export function deskStatusText(status: DeskStatus): string {
  return STATUS_TEXT[status]
}

const KIND_TEXT: Record<PlaceKind, string> = { meeting: 'Reunião', private: 'Privada', desk: 'Mesa', open: 'Aberta' }

const KIND_HINT: Record<PlaceKind, string> = {
  meeting: 'Só quem está dentro ouve e vê.',
  private: 'Só quem está dentro ouve e vê.',
  desk: 'Só quem está na mesa ouve e vê.',
  open: 'Conversa por proximidade: ouve quem está perto.',
}

export function kindText(kind: PlaceKind): string {
  return KIND_TEXT[kind]
}

export function kindHint(kind: PlaceKind): string {
  return KIND_HINT[kind]
}

export function countText(n: number): string {
  if (n === 0) return 'Vazia'
  return n === 1 ? '1 pessoa' : `${n} pessoas`
}

/** Shows the search over the people list from this many on. */
export const SEARCH_FROM = 8

// Accents and case do not count: "joao" finds "João".
export function fold(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('pt-BR').trim()
}

export function filterPeople<T extends Pick<Person, 'label'>>(people: readonly T[], query: string): T[] {
  const q = fold(query)
  return q === '' ? [...people] : people.filter((p) => fold(p.label).includes(q))
}
