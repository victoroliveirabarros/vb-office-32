import type { RosterFeed } from '../chat/feed'
import { ZoneMap } from '../game/zones'
import type { TileRect } from '../game/zones'
import { countText, kindHint, kindText, OPEN_FLOOR, places } from '../sidebar/places'
import type { Place, PlaceKind } from '../sidebar/places'
import { icon, requireElement } from './dom'
import type { Heads } from './heads'

// Heads shown per room before "+n".
const FACES = 6

const KIND_ICON: Record<PlaceKind, string> = { meeting: 'presentation', private: 'lock', open: 'coffee' }

const iconFor = (place: Place) => (place.id === OPEN_FLOOR.id ? 'building-2' : KIND_ICON[place.kind])

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

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

/** "Ana, Bia e mais 3", for screen readers and the tooltip. */
export function whoText(names: readonly string[], max = 4): string {
  if (names.length === 0) return 'Ninguém aqui agora'
  if (names.length <= max) return names.length === 1 ? names[0]! : `${names.slice(0, -1).join(', ')} e ${names[names.length - 1]!}`
  return `${names.slice(0, max).join(', ')} e mais ${names.length - max}`
}

/** The rooms and open areas of the map, who is in each, and a way to see it. */
export function createRooms(feed: RosterFeed, heads: Heads, showPlace: (tiles: TileRect) => void): { setZones(zones: ZoneMap): void } {
  const list = requireElement('rooms-list', HTMLUListElement)
  const rows = new Map<string, Row>()
  let zones = ZoneMap.empty()

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

  const render = () => {
    const items = places(zones, feed.roster.list()).map((place) => {
      const view = row(place)
      view.item.dataset.kind = place.kind
      view.item.classList.toggle('here', place.here)
      view.icon.replaceChildren(icon(iconFor(place)))
      view.name.textContent = place.name
      view.meta.textContent = `${kindText(place.kind)} · ${countText(place.people.length)}`
      view.meta.title = kindHint(place.kind)
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
    })
    const { children } = list
    if (children.length !== items.length || items.some((item, i) => children[i] !== item)) list.replaceChildren(...items)
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
