import type { RosterFeed } from '../chat/feed'
import { icon, requireElement } from './dom'
import type { Heads } from './heads'
import { inviteAction } from './people'

export type PopoverActions = {
  message(id: string): void
  invite(id: string, on: boolean): void
}

export type PersonPopover = { open(id: string): void }

/**
 * What a click on someone's avatar offers when we own a desk: a direct
 * message, or an invite to the desk or taking it back. Esc, a click
 * elsewhere or the person leaving closes it.
 */
export function createPersonPopover(feed: RosterFeed, heads: Heads, actions: PopoverActions): PersonPopover {
  const root = requireElement('person-popover', HTMLDivElement)
  const avatar = requireElement('person-popover-avatar', HTMLSpanElement)
  const name = requireElement('person-popover-name', HTMLSpanElement)
  const close = requireElement('person-popover-close', HTMLButtonElement)
  const message = requireElement('person-popover-message', HTMLButtonElement)
  const invite = requireElement('person-popover-invite', HTMLButtonElement)
  const head = heads.create('head')
  avatar.append(head)
  let shown: string | null = null
  let back: Element | null = null

  const hide = (restore: boolean) => {
    if (shown === null) return
    shown = null
    root.hidden = true
    if (restore && back instanceof HTMLElement) back.focus()
  }

  const render = () => {
    if (shown === null) return
    const id = shown
    const person = feed.roster.list().find((p) => p.id === id)
    const action = person ? inviteAction(person, feed.roster.desks) : null
    if (!person || !action) return hide(root.contains(document.activeElement))
    heads.draw(head, person.look)
    name.textContent = person.label
    const text = document.createElement('span')
    text.textContent = action.text
    invite.replaceChildren(icon(action.icon), text)
  }

  message.addEventListener('click', () => {
    const id = shown
    hide(false)
    if (id !== null) actions.message(id)
  })
  // Stays open, so the button turns into "Remover convite" once the server agrees.
  invite.addEventListener('click', () => {
    if (shown !== null) actions.invite(shown, !feed.roster.desks.invited(shown))
  })
  close.addEventListener('click', () => hide(true))
  root.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return
    e.preventDefault()
    e.stopPropagation()
    hide(true)
  })
  document.addEventListener(
    'pointerdown',
    (e) => {
      if (shown !== null && !(e.target instanceof Node && root.contains(e.target))) hide(false)
    },
    true,
  )
  feed.onChange(render)

  return {
    open(id) {
      if (shown === null) back = document.activeElement
      shown = id
      root.hidden = false
      render()
      if (shown !== null) message.focus()
    },
  }
}
