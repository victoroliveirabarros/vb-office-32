import { describe, expect, it } from 'vitest'
import { idTag, Names, nameKey } from './names'

describe('Names', () => {
  it('leaves unique names alone', () => {
    const names = new Names([
      ['oidc:1', 'Ana'],
      ['oidc:2', 'Bia'],
    ])
    expect(names.label('oidc:1', 'Ana')).toBe('Ana')
    expect(names.label('oidc:3', 'Caio')).toBe('Caio')
  })

  it('tags each repeated name with a short suffix from the id', () => {
    const names = new Names([
      ['oidc:1', 'Ana'],
      ['oidc:2', 'ana'],
      ['oidc:3', 'Bia'],
    ])
    const a = names.label('oidc:1', 'Ana')
    const b = names.label('oidc:2', 'ana')
    expect(a).toBe(`Ana #${idTag('oidc:1', 4)}`)
    expect(b).toBe(`ana #${idTag('oidc:2', 4)}`)
    expect(a.toLowerCase()).not.toBe(b.toLowerCase())
    expect(names.label('oidc:3', 'Bia')).toBe('Bia')
  })

  it('tags someone outside the list whose name collides', () => {
    const names = new Names([['oidc:1', 'Ana']])
    expect(names.label('oidc:9', 'Ana')).toMatch(/^Ana #[0-9a-z]{4}$/)
    expect(names.label('oidc:1', 'Ana')).toBe('Ana')
  })

  it('is stable for every viewer', () => {
    expect(idTag('oidc:1')).toBe(idTag('oidc:1'))
    expect(idTag('oidc:1')).toMatch(/^[0-9a-z]{7}$/)
    expect(idTag('oidc:1')).not.toBe(idTag('oidc:2'))
  })

  it('lengthens the tag until the ids differ', () => {
    // Search for two ids sharing their four-character tag.
    const seen = new Map<string, string>()
    let pair: [string, string] | null = null
    for (let i = 0; !pair; i++) {
      const id = `oidc:${i}`
      const head = idTag(id, 4)
      const other = seen.get(head)
      if (other) pair = [other, id]
      else seen.set(head, id)
    }
    const names = new Names(pair.map((id) => [id, 'Ana'] as const))
    const [x, y] = pair.map((id) => names.label(id, 'Ana'))
    expect(x).not.toBe(y)
    expect(x?.length).toBeGreaterThan('Ana #'.length + 4)
  })

  it('compares names ignoring case and spacing at the ends', () => {
    expect(nameKey(' Ana ')).toBe(nameKey('ANA'))
    expect(nameKey('Ａｎａ')).toBe(nameKey('ana'))
  })
})
