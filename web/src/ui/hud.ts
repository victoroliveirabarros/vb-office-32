import type { Room } from '../game/zones'
import { requireElement } from './dom'
import { zoneAnnouncement, zoneHint, zoneText } from './zone'

export type Hud = {
  setStatus(text: string | null): void
  setLatency(ms: number): void
  setZone(room: Room | null): void
}

export function createHud(): Hud {
  const status = requireElement('status', HTMLDivElement)
  const latency = requireElement('latency', HTMLSpanElement)
  const zone = requireElement('zone', HTMLDivElement)
  const zoneStatus = requireElement('zone-status', HTMLDivElement)
  let room: Room | null = null

  return {
    setStatus(text) {
      status.textContent = text ?? ''
      status.hidden = text === null
    },
    setLatency(ms) {
      latency.textContent = `${Math.round(ms)} ms`
      latency.hidden = false
    },
    setZone(next) {
      const said = zoneAnnouncement(room, next)
      room = next
      if (said !== null) zoneStatus.textContent = said
      zone.hidden = next === null
      zone.textContent = next ? zoneText(next) : ''
      zone.title = next ? zoneHint(next) : ''
      zone.dataset.kind = next?.kind ?? ''
    },
  }
}
