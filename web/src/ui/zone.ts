import type { Room } from '../game/zones'
import type { ZoneKind } from '../net/protocol'

const KIND_TEXT: Record<ZoneKind, string> = { meeting: 'reunião', private: 'privada', desk: 'mesa' }

// The share button shows in every zone with media, so no hint names it.
const KIND_HINT: Record<ZoneKind, string> = {
  meeting: 'Só quem está na sala ouve, vê e lê o chat “Perto”.',
  private: 'Só quem está aqui ouve, vê e lê o chat “Perto”.',
  desk: 'Só quem está na mesa ouve, vê e lê o chat “Perto”.',
}

/** What the texts call the zone we are in: "na mesa", "da sala". */
export function zoneWord(kind: ZoneKind | undefined): 'mesa' | 'sala' {
  return kind === 'desk' ? 'mesa' : 'sala'
}

/** "Ringue de box — privada"; just "Sala privada" when the name says it. */
export function zoneText(room: Room): string {
  const kind = KIND_TEXT[room.kind]
  return room.name.toLocaleLowerCase('pt-BR').includes(kind) ? room.name : `${room.name} — ${kind}`
}

export function zoneHint(room: Room): string {
  return KIND_HINT[room.kind]
}

/** What to tell a screen reader when we move from prev to next. */
export function zoneAnnouncement(prev: Room | null, next: Room | null): string | null {
  if (prev?.id === next?.id) return null
  if (next) return `Você entrou em ${zoneText(next)}. ${zoneHint(next)}`
  if (prev) return `Você saiu de ${prev.name}.`
  return null
}
