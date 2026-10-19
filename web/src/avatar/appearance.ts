import { isRecord } from '../guards'
import { BALD, CATEGORIES, FIELDS } from './catalog.gen'
import type { Field } from './catalog.gen'

/** One option of each category, by index into the catalog. */
export type Appearance = Readonly<Record<Field, number>>

export const DEFAULT_APPEARANCE: Appearance = { skin: 0, hair: 0, hairColor: 0, shirt: 0, pants: 0, acc: 0 }

export function optionCount(field: Field): number {
  return CATEGORIES.find((c) => c.field === field)?.options.length ?? 0
}

export function isValid(a: Appearance): boolean {
  return FIELDS.every((f) => Number.isInteger(a[f]) && a[f] >= 0 && a[f] < optionCount(f))
}

export function sameAppearance(a: Appearance, b: Appearance): boolean {
  return FIELDS.every((f) => a[f] === b[f])
}

/** Whether the hair color shows: not on a bald head. */
export function showsHairColor(a: Appearance): boolean {
  return a.hair !== BALD
}

/** Whether a and b look alike: a bald head hides the hair color. */
export function sameLook(a: Appearance, b: Appearance): boolean {
  if (showsHairColor(a) || showsHairColor(b)) return sameAppearance(a, b)
  return sameAppearance({ ...a, hairColor: 0 }, { ...b, hairColor: 0 })
}

/** The compact form "skin.hair.hairColor.shirt.pants.acc". */
export function formatAppearance(a: Appearance): string {
  return FIELDS.map((f) => a[f]).join('.')
}

const NUMBER = /^[0-9]+$/

/**
 * Reads the compact form as the server does: missing trailing fields are 0;
 * extra fields, anything but decimal numbers and options outside the
 * catalog are null.
 */
export function parseAppearance(s: string): Appearance | null {
  const parts = s.split('.')
  if (s === '' || parts.length > FIELDS.length) return null
  const out: Record<Field, number> = { ...DEFAULT_APPEARANCE }
  for (const [i, part] of parts.entries()) {
    const field = FIELDS[i]
    if (field === undefined || !NUMBER.test(part)) return null
    out[field] = Number(part)
  }
  return isValid(out) ? out : null
}

const isByte = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 255

/**
 * Reads an appearance off the wire. Absent fields are 0 and unknown keys
 * ignored; a field that is not a byte makes it null. An option this client
 * does not know yet, from a newer catalog, is shown as the first one.
 */
export function fromWire(v: unknown): Appearance | null {
  if (!isRecord(v)) return null
  const out: Record<Field, number> = { ...DEFAULT_APPEARANCE }
  for (const field of FIELDS) {
    const value = v[field] ?? 0
    if (!isByte(value)) return null
    out[field] = value < optionCount(field) ? value : 0
  }
  return out
}

/** A random look that does not look like current. */
export function randomAppearance(current: Appearance, random: () => number = Math.random): Appearance {
  const pick = (f: Field) => Math.floor(random() * optionCount(f)) % optionCount(f)
  const out: Record<Field, number> = { ...DEFAULT_APPEARANCE }
  for (const f of FIELDS) out[f] = pick(f)
  if (sameLook(out, current)) out.shirt = (out.shirt + 1) % optionCount('shirt')
  return out
}

export function withOption(a: Appearance, field: Field, index: number): Appearance {
  if (!Number.isInteger(index) || index < 0 || index >= optionCount(field)) return a
  return { ...a, [field]: index }
}
