import { requireElement } from './dom'

export type Hud = {
  setStatus(text: string | null): void
  setLatency(ms: number): void
}

export function createHud(): Hud {
  const status = requireElement('status', HTMLDivElement)
  const latency = requireElement('latency', HTMLDivElement)

  return {
    setStatus(text) {
      status.textContent = text ?? ''
      status.hidden = text === null
    },
    setLatency(ms) {
      latency.textContent = `${Math.round(ms)} ms`
      latency.hidden = false
    },
  }
}
