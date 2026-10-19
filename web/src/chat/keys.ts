export type KeyLike = {
  key: string
  keyCode?: number
  isComposing?: boolean
  shiftKey?: boolean
  ctrlKey?: boolean
  altKey?: boolean
  metaKey?: boolean
  defaultPrevented?: boolean
}

export type TargetLike = { tagName?: string; isContentEditable?: boolean } | null

export type ScrollLike = { scrollTop: number; scrollHeight: number; clientHeight: number }

const EDITABLE = new Set(['INPUT', 'TEXTAREA', 'SELECT'])
const ACTIVATES_ON_ENTER = new Set(['BUTTON', 'A', 'SUMMARY'])

export function isEditable(target: TargetLike): boolean {
  if (!target) return false
  return target.isContentEditable === true || EDITABLE.has(target.tagName ?? '')
}

// keyCode 229 is the IME's own keydown, sent while it composes.
export function isComposing(e: KeyLike): boolean {
  return e.isComposing === true || e.keyCode === 229
}

function modified(e: KeyLike): boolean {
  return e.shiftKey === true || e.ctrlKey === true || e.altKey === true || e.metaKey === true
}

/** A bare Enter outside any control opens the chat. */
export function shouldFocusChat(e: KeyLike, target: TargetLike): boolean {
  if (e.key !== 'Enter' || e.defaultPrevented || isComposing(e) || modified(e)) return false
  return !isEditable(target) && !ACTIVATES_ON_ENTER.has(target?.tagName ?? '')
}

export type InputAction = 'send' | 'leave' | null

/** Enter sends, Shift+Enter breaks the line, Esc leaves the input. */
export function inputAction(e: KeyLike): InputAction {
  if (isComposing(e)) return null
  if (e.key === 'Escape') return 'leave'
  if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) return 'send'
  return null
}

export function atBottom(el: ScrollLike, slack = 8): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= slack
}

/** Lets the chat take the keyboard away from the game while it is focused. */
export type TypingGate = { setTyping(on: boolean): void }
