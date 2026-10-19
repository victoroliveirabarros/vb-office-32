import { describe, expect, it } from 'vitest'
import { AllowedSubscribers } from './permissions'

describe('AllowedSubscribers', () => {
  it('sends sorted ids only when the set changes', () => {
    const allowed = new AllowedSubscribers()
    expect(allowed.update([])).toEqual([])
    expect(allowed.update([])).toBeNull()
    expect(allowed.update(['b', 'a', 'b'])).toEqual(['a', 'b'])
    expect(allowed.update(new Set(['a', 'b']))).toBeNull()
    expect(allowed.update(['a'])).toEqual(['a'])
    expect(allowed.update([])).toEqual([])
  })

  it('restricts to ids already sent, and to none after a reset', () => {
    const allowed = new AllowedSubscribers()
    allowed.update(['a', 'b'])
    expect(allowed.restrict(['b', 'c'])).toEqual(['b'])
    expect(allowed.restrict(['a', 'b', 'c'])).toBeNull()
    expect(allowed.update(['b', 'c'])).toEqual(['b', 'c'])
    allowed.reset()
    expect(allowed.restrict(['b'])).toEqual([])
  })

  it('sends again after a reset', () => {
    const allowed = new AllowedSubscribers()
    allowed.update(['a'])
    allowed.reset()
    expect(allowed.update(['a'])).toEqual(['a'])
  })
})
