import { normalizeName } from '../net/protocol'
import { requireElement } from './dom'

const STORAGE_KEY = 'vb-office-32.name'

export function askName(): Promise<string> {
  const overlay = requireElement('join', HTMLDivElement)
  const form = requireElement('join-form', HTMLFormElement)
  const input = requireElement('join-name', HTMLInputElement)
  const error = requireElement('join-error', HTMLParagraphElement)

  input.value = loadName()
  overlay.hidden = false
  input.focus()

  return new Promise((resolve) => {
    form.addEventListener('submit', function onSubmit(event) {
      event.preventDefault()
      const name = normalizeName(input.value)
      if (!name) {
        error.hidden = false
        return
      }
      form.removeEventListener('submit', onSubmit)
      saveName(name)
      overlay.hidden = true
      resolve(name)
    })
  })
}

function loadName(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? ''
  } catch {
    return ''
  }
}

function saveName(name: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, name)
  } catch {
    // storage unavailable (private mode); remembering the name is optional
  }
}
