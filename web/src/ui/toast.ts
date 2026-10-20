import type { DeskInvite, ServerMessage } from '../net/protocol'
import { icon, requireElement } from './dom'

const TOAST_MS = 5000
const MAX_TOASTS = 3

export function inviteText(invite: Pick<DeskInvite, 'ownerName' | 'invited'>): string {
  return invite.invited ? `${invite.ownerName} convidou você para a mesa` : `Convite para a mesa de ${invite.ownerName} removido`
}

/**
 * Tells a guest for a few seconds that an owner invited them to a desk or
 * took the invite back. The invites the server repeats on connecting, from
 * the welcome to the chat history, are no news.
 */
export function createToasts(link: { onMessage(fn: (msg: ServerMessage) => void): unknown }): void {
  const region = requireElement('toasts', HTMLDivElement)
  let joining = false

  const show = (text: string) => {
    const toast = document.createElement('div')
    toast.className = 'toast brand'
    const body = document.createElement('span')
    body.textContent = text
    toast.append(icon('armchair'), body)
    region.append(toast)
    while (region.children.length > MAX_TOASTS) region.firstElementChild?.remove()
    setTimeout(() => toast.remove(), TOAST_MS)
  }

  link.onMessage((msg) => {
    if (msg.t === 'welcome') joining = true
    else if (msg.t === 'chatHistory') joining = false
    else if (msg.t === 'deskInvite' && !joining) show(inviteText(msg.d))
  })
}
