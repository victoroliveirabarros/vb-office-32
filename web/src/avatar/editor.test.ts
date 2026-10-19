import { describe as group, expect, it } from 'vitest'
import { DEFAULT_APPEARANCE, sameAppearance } from './appearance'
import { BALD } from './catalog.gen'
import { describe, EditorState } from './editor'

const mine = { skin: 2, hair: 1, hairColor: 3, shirt: 4, pants: 1, acc: 0 }

function opened(): EditorState {
  const state = new EditorState()
  state.setCurrent(mine)
  state.open()
  return state
}

group('EditorState', () => {
  it('opens on the current look', () => {
    const state = opened()
    expect(state.draft).toEqual(mine)
    expect(state.dirty).toBe(false)
  })

  it('selects one option at a time, within the catalog', () => {
    const state = opened()
    state.select('shirt', 1)
    state.select('acc', 3)
    state.select('hair', 99)
    expect(state.draft).toEqual({ ...mine, shirt: 1, acc: 3 })
    expect(state.current).toEqual(mine)
    expect(state.dirty).toBe(true)
  })

  it('randomizes to something other than the draft', () => {
    const state = opened()
    for (let i = 0; i < 50; i++) {
      const before = state.draft
      state.randomize()
      expect(sameAppearance(state.draft, before)).toBe(false)
    }
    const fixed = opened()
    fixed.randomize(() => 0)
    expect(sameAppearance(fixed.draft, mine)).toBe(false)
  })

  it('cancels back to the current look', () => {
    const state = opened()
    state.select('skin', 4)
    expect(state.cancel()).toEqual(mine)
    expect(state.draft).toEqual(mine)
    expect(state.dirty).toBe(false)
  })

  it('saves the draft, and nothing when unchanged', () => {
    const state = opened()
    expect(state.save()).toBeNull()
    state.select('pants', 3)
    expect(state.save()).toEqual({ ...mine, pants: 3 })
    expect(state.current).toEqual({ ...mine, pants: 3 })
    expect(state.dirty).toBe(false)
    expect(state.save()).toBeNull()
  })

  it('follows the server unless the draft was touched', () => {
    const state = opened()
    state.setCurrent(DEFAULT_APPEARANCE)
    expect(state.draft).toEqual(DEFAULT_APPEARANCE)
    state.select('shirt', 2)
    state.setCurrent(mine)
    expect(state.draft).toEqual({ ...DEFAULT_APPEARANCE, shirt: 2 })
    expect(state.cancel()).toEqual(mine)
  })

  it('keeps the hair color while bald', () => {
    const state = opened()
    state.select('hair', BALD)
    expect(state.draft).toEqual({ ...mine, hair: BALD })
    state.select('hair', 3)
    expect(state.draft).toEqual({ ...mine, hair: 3 })
    expect(state.draft.hairColor).toBe(mine.hairColor)
  })

  it('reopens on the current look after a cancel', () => {
    const state = opened()
    state.select('hair', 4)
    state.cancel()
    state.open()
    expect(state.draft).toEqual(mine)
  })
})

group('describe', () => {
  it('names every choice in Portuguese', () => {
    expect(describe(mine)).toBe('Pele tom 3, cabelo topete ruivo, camisa vermelho, calça preta, sem acessório')
    expect(describe({ ...mine, acc: 1 })).toMatch(/, óculos$/)
    expect(describe({ ...mine, hair: BALD })).toBe('Pele tom 3, careca, camisa vermelho, calça preta, sem acessório')
  })
})
