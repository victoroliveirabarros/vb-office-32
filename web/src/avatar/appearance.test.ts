import { describe, expect, it } from 'vitest'
import { DEFAULT_APPEARANCE, formatAppearance, fromWire, isValid, optionCount, parseAppearance, randomAppearance, sameAppearance, sameLook, showsHairColor, withOption } from './appearance'
import { BALD, CATEGORIES, FIELDS } from './catalog.gen'

const look = { skin: 4, hair: 2, hairColor: 7, shirt: 1, pants: 3, acc: 2 }

describe('compact form', () => {
  it('round-trips', () => {
    expect(formatAppearance(look)).toBe('4.2.7.1.3.2')
    expect(parseAppearance('4.2.7.1.3.2')).toEqual(look)
    expect(formatAppearance(DEFAULT_APPEARANCE)).toBe('0.0.0.0.0.0')
    expect(parseAppearance('2.6.3')).toEqual({ ...DEFAULT_APPEARANCE, skin: 2, hair: BALD, hairColor: 3 })
  })

  it('fills missing trailing fields with 0', () => {
    expect(parseAppearance('3')).toEqual({ ...DEFAULT_APPEARANCE, skin: 3 })
    expect(parseAppearance('1.2.3')).toEqual({ ...DEFAULT_APPEARANCE, skin: 1, hair: 2, hairColor: 3 })
    expect(parseAppearance('007')).toBeNull()
    expect(parseAppearance('04')).toEqual({ ...DEFAULT_APPEARANCE, skin: 4 })
  })

  it('refuses extras, non-numbers and options outside the catalog', () => {
    for (const s of ['', '.', '1.', '0.0.0.0.0.0.0', '-1', '+1', '1.a', ' 1', '1.2.3.4.5.6', '5', '0.7', '0.0.8', '0.0.0.0.4', '0.0.0.0.0.4', '1e1', '0x1']) {
      expect(parseAppearance(s), s).toBeNull()
    }
  })
})

describe('fromWire', () => {
  it('reads a full appearance', () => {
    expect(fromWire(look)).toEqual(look)
  })

  it('treats absent fields as 0 and ignores unknown keys', () => {
    expect(fromWire({})).toEqual(DEFAULT_APPEARANCE)
    expect(fromWire({ skin: 2, hat: 9 })).toEqual({ ...DEFAULT_APPEARANCE, skin: 2 })
  })

  it('shows options from a newer catalog as the first one', () => {
    expect(fromWire({ ...look, hair: 7, shirt: 200 })).toEqual({ ...look, hair: 0, shirt: 0 })
    expect(fromWire({ ...look, hair: 6 })).toEqual({ ...look, hair: BALD })
  })

  it('refuses what is not a byte', () => {
    for (const v of [null, 'x', [1], { skin: -1 }, { skin: 1.5 }, { skin: 256 }, { skin: '1' }, { acc: true }]) {
      expect(fromWire(v), JSON.stringify(v)).toBeNull()
    }
  })
})

describe('randomAppearance', () => {
  it('is always valid and never the current look', () => {
    let seed = 1
    const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646
    for (let i = 0; i < 500; i++) {
      const next = randomAppearance(look, random)
      expect(isValid(next)).toBe(true)
      expect(sameAppearance(next, look)).toBe(false)
    }
  })

  it('never repeats a bald look with only another hair color', () => {
    const bald = { ...look, hair: BALD }
    // The dice land on the current look but for the hidden hair color.
    const dice = FIELDS.map((f) => ((f === 'hairColor' ? (bald.hairColor + 1) % optionCount(f) : bald[f]) + 0.5) / optionCount(f))
    let i = 0
    const next = randomAppearance(bald, () => dice[i++ % dice.length] ?? 0)
    expect(next.hair).toBe(BALD)
    expect(sameLook(next, bald)).toBe(false)
    expect(next.shirt).not.toBe(bald.shirt)
  })

  it('may pick the bald style', () => {
    expect(randomAppearance(look, () => (BALD + 0.5) / optionCount('hair')).hair).toBe(BALD)
  })

  it('changes a field when the dice repeat the current look', () => {
    const zero = randomAppearance(DEFAULT_APPEARANCE, () => 0)
    expect(sameAppearance(zero, DEFAULT_APPEARANCE)).toBe(false)
    expect(isValid(randomAppearance(DEFAULT_APPEARANCE, () => 0.9999999))).toBe(true)
  })
})

describe('withOption', () => {
  it('sets one field inside the catalog only', () => {
    expect(withOption(look, 'shirt', 7)).toEqual({ ...look, shirt: 7 })
    expect(withOption(look, 'shirt', optionCount('shirt'))).toBe(look)
    expect(withOption(look, 'acc', -1)).toBe(look)
  })
})

describe('bald', () => {
  it('is the hair style Careca, appended to the catalog', () => {
    expect(CATEGORIES.find((c) => c.field === 'hair')?.options[BALD]?.label).toBe('Careca')
    expect(optionCount('hair')).toBe(7)
  })

  it('hides the hair color', () => {
    expect(showsHairColor(look)).toBe(true)
    expect(showsHairColor({ ...look, hair: BALD })).toBe(false)
    expect(sameLook({ ...look, hair: BALD, hairColor: 1 }, { ...look, hair: BALD, hairColor: 5 })).toBe(true)
    expect(sameLook({ ...look, hairColor: 1 }, { ...look, hairColor: 5 })).toBe(false)
    expect(sameLook({ ...look, hair: BALD }, look)).toBe(false)
  })
})
