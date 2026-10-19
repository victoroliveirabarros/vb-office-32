import { requireElement } from './dom'

export function showLogin(): void {
  requireElement('login', HTMLDivElement).hidden = false
}
