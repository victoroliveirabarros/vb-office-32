import { requireElement } from './dom'

export function showLogin(): void {
  requireElement('login', HTMLDivElement).hidden = false
}

export function showLogout(onLogout: () => void): void {
  const button = requireElement('logout', HTMLButtonElement)
  button.hidden = false
  button.addEventListener('click', () => {
    button.disabled = true
    onLogout()
  })
}
