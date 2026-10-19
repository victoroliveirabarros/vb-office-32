import { DEFAULT_APPEARANCE, randomAppearance, sameAppearance, withOption } from './appearance'
import type { Appearance } from './appearance'
import { CATEGORIES } from './catalog.gen'
import type { Field } from './catalog.gen'

/**
 * The editor's draft: opened on the current look, changed one option at a
 * time, then saved or thrown away.
 */
export class EditorState {
  private saved: Appearance = DEFAULT_APPEARANCE
  private shown: Appearance = DEFAULT_APPEARANCE

  get current(): Appearance {
    return this.saved
  }

  get draft(): Appearance {
    return this.shown
  }

  get dirty(): boolean {
    return !sameAppearance(this.saved, this.shown)
  }

  /** The look the server says we have; the draft follows only when untouched. */
  setCurrent(a: Appearance): void {
    if (!this.dirty) this.shown = a
    this.saved = a
  }

  open(): void {
    this.shown = this.saved
  }

  select(field: Field, index: number): void {
    this.shown = withOption(this.shown, field, index)
  }

  randomize(random?: () => number): void {
    this.shown = randomAppearance(this.shown, random)
  }

  cancel(): Appearance {
    this.shown = this.saved
    return this.saved
  }

  /** Returns the look to save and send, or null when nothing changed. */
  save(): Appearance | null {
    if (!this.dirty) return null
    this.saved = this.shown
    return this.saved
  }
}

const label = (field: Field, index: number) => CATEGORIES.find((c) => c.field === field)?.options[index]?.label ?? ''

/** What the preview shows, for screen readers. */
export function describe(a: Appearance): string {
  const acc = a.acc === 0 ? 'sem acessório' : label('acc', a.acc).toLowerCase()
  return (
    `Pele ${label('skin', a.skin).toLowerCase()}, cabelo ${label('hair', a.hair).toLowerCase()} ${label('hairColor', a.hairColor).toLowerCase()}, ` +
    `camisa ${label('shirt', a.shirt).toLowerCase()}, calça ${label('pants', a.pants).toLowerCase()}, ${acc}`
  )
}
