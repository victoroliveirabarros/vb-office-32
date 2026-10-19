import type { RosterFeed } from '../chat/feed'
import { requireElement } from './dom'
import type { Heads } from './heads'
import { placeText } from './people'

/** The top of the sidebar: our avatar's head, name and where we are. */
export function createProfile(feed: RosterFeed, heads: Heads): void {
  const root = requireElement('profile', HTMLDivElement)
  const head = requireElement('profile-head', HTMLCanvasElement)
  const name = requireElement('profile-name', HTMLSpanElement)
  const place = requireElement('profile-place', HTMLSpanElement)

  feed.onChange(() => {
    const self = feed.roster.list().find((p) => p.self)
    if (!self) return
    root.hidden = false
    heads.draw(head, self.look)
    const where = placeText(self)
    name.textContent = self.label
    place.textContent = where
    place.dataset.kind = self.room?.kind ?? 'open'
    root.title = `${self.label} · ${where}`
  })
}
