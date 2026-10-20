import type { RosterFeed } from '../chat/feed'
import { ZoneMap } from '../game/zones'
import type { TileRect } from '../game/zones'
import { countText, deskGuestRows, deskPlaces, deskStatusText, kindHint, kindText, OPEN_FLOOR, places } from '../sidebar/places'
import type { DeskGuestRow, DeskPlace, Place, PlaceKind } from '../sidebar/places'
import { icon, requireElement } from './dom'
import type { Heads } from './heads'

// Heads shown per room before "+n".
const FACES = 6

const KIND_ICON: Record<PlaceKind, string> = { meeting: 'presentation', private: 'lock', desk: 'armchair', open: 'coffee' }

const iconFor = (place: Place) => (place.id === OPEN_FLOOR.id ? 'building-2' : KIND_ICON[place.kind])

const DESK_HINT = { locked: 'Só o dono e os convidados entram.', open: 'Você pode entrar.' } as const

type Row = {
  item: HTMLLIElement
  icon: HTMLSpanElement
  name: HTMLSpanElement
  meta: HTMLSpanElement
  here: HTMLSpanElement
  people: HTMLDivElement
  faces: HTMLDivElement
  names: HTMLSpanElement
  show: HTMLButtonElement
}

type GuestRow = { item: HTMLLIElement; name: HTMLSpanElement; status: HTMLSpanElement; revoke: HTMLButtonElement }

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function replace(list: HTMLUListElement, items: HTMLLIElement[]): void {
  const { children } = list
  if (children.length !== items.length || items.some((item, i) => children[i] !== item)) list.replaceChildren(...items)
}

/** "Ana, Bia e mais 3", for screen readers and the tooltip. */
export function whoText(names: readonly string[], max = 4): string {
  if (names.length === 0) return 'Ninguém aqui agora'
  if (names.length <= max) return names.length === 1 ? names[0]! : `${names.slice(0, -1).join(', ')} e ${names[names.length - 1]!}`
  return `${names.slice(0, max).join(', ')} e mais ${names.length - max}`
}

/**
 * The rooms, open areas and desks of the map, who is in each, and a way to
 * see it. Our own desk also lists whom we invited, offline ones included,
 * whom Pessoas does not show, each with a way to take the invite back.
 */
export function createRooms(feed: RosterFeed, heads: Heads, showPlace: (tiles: TileRect) => void, revoke: (id: string) => void): { setZones(zones: ZoneMap): void } {
  const list = requireElement('rooms-list', HTMLUListElement)
  const deskSection = requireElement('desks-section', HTMLElement)
  const deskList = requireElement('desks-list', HTMLUListElement)
  const rows = new Map<string, Row>()
  let zones = ZoneMap.empty()

  const guestBox = el('div', 'desk-guests')
  const guestTitle = el('span', 'desk-guests-title', 'Convidados')
  guestTitle.id = 'desk-guests-title'
  const guestList = el('ul', 'desk-guests-list')
  guestList.setAttribute('aria-labelledby', guestTitle.id)
  guestBox.append(guestTitle, guestList)
  const guestRows = new Map<string, GuestRow>()

  const guestRow = (guest: DeskGuestRow): HTMLLIElement => {
    let view = guestRows.get(guest.id)
    if (!view) {
      const item = el('li', 'desk-guest')
      const name = el('span', 'desk-guest-name')
      name.dir = 'auto'
      const status = el('span', 'desk-guest-status')
      const button = el('button', 'button button-ghost desk-guest-revoke')
      button.type = 'button'
      button.append(icon('user-minus'), el('span', '', 'Remover convite'))
      const id = guest.id
      button.addEventListener('click', () => revoke(id))
      item.append(name, status, button)
      view = { item, name, status, revoke: button }
      guestRows.set(id, view)
    }
    view.item.dataset.online = String(guest.online)
    view.name.textContent = guest.label
    view.status.textContent = guest.status
    view.revoke.setAttribute('aria-label', guest.revoke)
    return view.item
  }

  // A guest gone from the list takes the focus to the next one, else to the desk's own button.
  const guests = (item: HTMLLIElement, show: HTMLButtonElement) => {
    const roster = feed.roster
    const shown = deskGuestRows(roster.desks.guests(), (id, name) => roster.labelFor(id, name))
    const ids = new Set(shown.map((g) => g.id))
    let lost = false
    for (const [id, view] of guestRows) {
      if (ids.has(id)) continue
      lost ||= view.item.contains(document.activeElement)
      guestRows.delete(id)
    }
    replace(guestList, shown.map(guestRow))
    guestBox.hidden = shown.length === 0
    if (guestBox.parentElement !== item) item.append(guestBox)
    if (lost) (guestList.querySelector('button') ?? show).focus()
  }

  const row = (place: Place): Row => {
    let view = rows.get(place.id)
    if (view) return view
    const item = el('li', 'room')
    const head = el('div', 'room-head')
    const iconBox = el('span', 'room-icon')
    iconBox.setAttribute('aria-hidden', 'true')
    const text = el('span', 'room-text')
    const name = el('span', 'room-name')
    name.dir = 'auto'
    const meta = el('span', 'room-meta')
    text.append(name, meta)
    const here = el('span', 'room-here', 'Você está aqui')
    const show = el('button', 'icon-button room-show')
    show.type = 'button'
    show.title = 'Ver na visão geral'
    show.append(icon('locate'))
    head.append(iconBox, text, show)
    const people = el('div', 'room-people')
    const faces = el('div', 'room-faces')
    faces.setAttribute('aria-hidden', 'true')
    const names = el('span', 'room-names')
    names.dir = 'auto'
    people.append(faces, names, here)
    item.append(head, people)
    const tiles = place.tiles
    if (tiles) show.addEventListener('click', () => showPlace(tiles))
    else show.hidden = true
    view = { item, icon: iconBox, name, meta, here, people, faces, names, show }
    rows.set(place.id, view)
    return view
  }

  const fill = (place: Place, meta: string, hint: string, iconName: string): HTMLLIElement => {
    const view = row(place)
    view.item.dataset.kind = place.kind
    view.item.classList.toggle('here', place.here)
    if (view.icon.dataset.icon !== iconName) view.icon.replaceChildren(icon(iconName))
    view.icon.dataset.icon = iconName
    view.name.textContent = place.name
    view.meta.textContent = meta
    view.meta.title = hint
    view.here.hidden = !place.here
    const labels = place.people.map((p) => (p.self ? `${p.label} (você)` : p.label))
    view.names.textContent = whoText(labels)
    view.names.title = labels.join(', ')
    const faces: HTMLElement[] = place.people.slice(0, FACES).map((person) => {
      const face = el('span', 'room-face')
      const canvas = heads.create('head')
      heads.draw(canvas, person.look)
      face.append(canvas)
      return face
    })
    const extra = place.people.length - FACES
    if (extra > 0) faces.push(el('span', 'room-face room-more', `+${extra}`))
    view.faces.replaceChildren(...faces)
    view.people.hidden = faces.length === 0
    view.show.setAttribute('aria-label', `Ver ${place.name} na visão geral`)
    return view.item
  }

  const desk = (place: DeskPlace) => {
    const meta = `${deskStatusText(place.status)} · ${countText(place.people.length)}`
    const item = fill(place, meta, DESK_HINT[place.lockedForMe ? 'locked' : 'open'], place.lockedForMe ? 'lock' : 'lock-open')
    item.dataset.status = place.status
    item.classList.toggle('locked', place.lockedForMe)
    // The lock is an icon; "Offline · fechada" already says it.
    if (place.lockedForMe && place.status === 'online') rows.get(place.id)?.meta.append(el('span', 'sr-only', ' · fechada para você'))
    const show = rows.get(place.id)?.show
    if (place.own && show) guests(item, show)
    else if (guestBox.parentElement === item) guestBox.remove()
    return item
  }

  const render = () => {
    const people = feed.roster.list()
    const rooms = places(zones, people).map((place) => fill(place, `${kindText(place.kind)} · ${countText(place.people.length)}`, kindHint(place.kind), iconFor(place)))
    replace(list, rooms)
    const desks = deskPlaces(zones, feed.roster.desks, people).map(desk)
    deskSection.hidden = desks.length === 0
    replace(deskList, desks)
  }

  feed.onChange(render)
  return {
    setZones(next) {
      zones = next
      for (const id of [...rows.keys()]) rows.delete(id)
      render()
    },
  }
}
