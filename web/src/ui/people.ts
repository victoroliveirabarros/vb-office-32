import type { RosterFeed } from '../chat/feed'
import type { Person } from '../chat/roster'
import type { Desks } from '../game/desks'
import { filterPeople, placeOf, SEARCH_FROM } from '../sidebar/places'
import type { SpeakingSource } from '../scenes/OfficeScene'
import { personTag } from './chat'
import { icon, requireElement } from './dom'
import type { Heads } from './heads'

export type PeopleActions = {
  message(id: string): void
  locate(id: string): void
  /** Invites id to our desk, or takes the invite back. */
  invite(id: string, on: boolean): void
}

export type InviteAction = { invite: boolean; icon: string; text: string; label: string }

/** Inviting someone else to our desk or taking it back; null without a desk of ours. */
export function inviteAction(person: Pick<Person, 'id' | 'self' | 'label'>, desks: Pick<Desks, 'mine' | 'invited'>): InviteAction | null {
  if (person.self || !desks.mine()) return null
  return desks.invited(person.id)
    ? { invite: false, icon: 'user-minus', text: 'Remover convite', label: `Remover convite de ${person.label}` }
    : { invite: true, icon: 'user-plus', text: 'Convidar para minha mesa', label: `Convidar ${person.label} para minha mesa` }
}

type Row = {
  item: HTMLLIElement
  avatar: HTMLSpanElement
  head: HTMLCanvasElement
  name: HTMLSpanElement
  place: HTMLSpanElement
  tag: HTMLSpanElement
  invite: HTMLButtonElement
  inviteIcon: string
  message: HTMLButtonElement
  locate: HTMLButtonElement
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function iconButton(name: string, className: string): HTMLButtonElement {
  const button = el('button', `icon-button ${className}`)
  button.type = 'button'
  button.append(icon(name))
  return button
}

export function peopleSummary(total: number, shown: number, query: string): string {
  if (query.trim() !== '') return shown === 0 ? 'Ninguém com esse nome.' : `${shown} de ${total} no escritório`
  return total === 1 ? 'Só você no escritório' : `${total} pessoas no escritório`
}

/** Where someone is, as the list says it. */
export function placeText(person: Pick<Person, 'room' | 'area'>): string {
  return placeOf(person).name
}

/**
 * Everyone in the office with their head, where they are and whether they
 * speak; a message and "Ver no mapa" for each, and an invite to our desk
 * when we have one.
 */
export function createPeople(feed: RosterFeed, heads: Heads, speakers: SpeakingSource, actions: PeopleActions, onCount: (n: number) => void): void {
  const searchRow = requireElement('people-search-row', HTMLDivElement)
  const search = requireElement('people-search', HTMLInputElement)
  const summary = requireElement('people-summary', HTMLParagraphElement)
  const list = requireElement('people-list', HTMLUListElement)
  const roster = feed.roster
  const rows = new Map<string, Row>()
  let speaking: ReadonlySet<string> = new Set()

  const row = (person: Person): Row => {
    let view = rows.get(person.id)
    if (view) return view
    const item = el('li', 'person')
    const avatar = el('span', 'person-avatar')
    const head = heads.create('head')
    avatar.append(head)
    const text = el('span', 'person-text')
    const name = el('span', 'person-name')
    name.dir = 'auto'
    const place = el('span', 'person-place')
    place.dir = 'auto'
    text.append(name, place)
    const tag = el('span', 'person-tag')
    const message = iconButton('message-circle', 'person-action')
    const invite = iconButton('user-plus', 'person-action person-invite')
    const locate = iconButton('locate', 'person-action')
    const tools = el('span', 'person-actions')
    tools.append(message, invite, locate)
    item.append(avatar, text, tag, tools)
    const id = person.id
    invite.addEventListener('click', () => actions.invite(id, !roster.desks.invited(id)))
    message.addEventListener('click', () => actions.message(id))
    locate.addEventListener('click', () => actions.locate(id))
    view = { item, avatar, head, name, place, tag, invite, inviteIcon: 'user-plus', message, locate }
    rows.set(id, view)
    return view
  }

  const render = () => {
    const everyone = roster.list()
    onCount(everyone.length)
    searchRow.hidden = everyone.length < SEARCH_FROM && search.value === ''
    const shown = filterPeople(everyone, searchRow.hidden ? '' : search.value)
    summary.textContent = peopleSummary(everyone.length, shown.length, searchRow.hidden ? '' : search.value)
    const items = shown.map((person) => {
      const view = row(person)
      const tag = personTag(person, roster)
      const talking = speaking.has(person.id)
      heads.draw(view.head, person.look)
      view.name.textContent = person.self ? `${person.label} (você)` : person.label
      view.place.textContent = placeText(person)
      view.place.dataset.kind = person.room?.kind ?? 'open'
      view.tag.textContent = talking ? 'falando' : (tag?.text ?? '')
      view.tag.dataset.kind = talking ? 'speaking' : (tag?.kind ?? '')
      view.tag.hidden = !talking && tag === null
      view.avatar.classList.toggle('speaking', talking)
      view.item.classList.toggle('self', person.self)
      const invite = inviteAction(person, roster.desks)
      view.invite.hidden = invite === null
      if (invite) {
        if (invite.icon !== view.inviteIcon) view.invite.replaceChildren(icon(invite.icon))
        view.inviteIcon = invite.icon
        view.invite.setAttribute('aria-label', invite.label)
        view.invite.title = invite.text
      }
      view.message.hidden = person.self
      view.message.setAttribute('aria-label', `Mensagem para ${person.label}`)
      view.message.title = 'Mensagem direta'
      const where = person.self ? 'Ver você no mapa' : `Ver ${person.label} no mapa`
      view.locate.setAttribute('aria-label', where)
      view.locate.title = 'Ver no mapa'
      return view.item
    })
    for (const id of [...rows.keys()]) if (!roster.online(id)) rows.delete(id)
    const { children } = list
    if (children.length !== items.length || items.some((item, i) => children[i] !== item)) list.replaceChildren(...items)
  }

  search.addEventListener('input', render)
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && search.value !== '') {
      e.preventDefault()
      e.stopPropagation()
      search.value = ''
      render()
    }
  })
  feed.onChange(render)
  speakers.onSpeaking((ids) => {
    speaking = ids
    render()
  })
  render()
}
