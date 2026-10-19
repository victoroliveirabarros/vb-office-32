import type { Room } from '../game/zones'
import type { ZoneKind } from '../net/protocol'

const KIND_TEXT: Record<ZoneKind, string> = { meeting: 'reunião', private: 'privada' }

const KIND_HINT: Record<ZoneKind, string> = {
  meeting: 'Só quem está na sala ouve, vê e lê o chat “Perto”; dá para compartilhar a tela.',
  private: 'Só quem está aqui ouve, vê e lê o chat “Perto”.',
}

/** "Sala 1 — reunião". */
export function zoneText(room: Room): string {
  return `${room.name} — ${KIND_TEXT[room.kind]}`
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
