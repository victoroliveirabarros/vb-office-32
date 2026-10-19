import { describe, expect, it } from 'vitest'
import { DEFAULT_APPEARANCE } from './appearance'
import { LookCache, lookKey } from './looks'

function cache() {
  const log: string[] = []
  const looks = new LookCache({ add: (key) => log.push(`+${key}`), remove: (key) => log.push(`-${key}`) })
  return { log, looks }
}

describe('LookCache', () => {
  const blue = { ...DEFAULT_APPEARANCE, shirt: 6 }

  it('composes a look once and drops it with its last wearer', () => {
    const { log, looks } = cache()
    const a = looks.acquire(DEFAULT_APPEARANCE)
    const b = looks.acquire({ ...DEFAULT_APPEARANCE })
    expect(a).toBe('avatar:0.0.0.0.0.0')
    expect(b).toBe(a)
    expect(log).toEqual(['+avatar:0.0.0.0.0.0'])
    looks.release(a)
    expect(log).toHaveLength(1)
    looks.release(b)
    expect(log).toEqual(['+avatar:0.0.0.0.0.0', '-avatar:0.0.0.0.0.0'])
    expect(looks.size).toBe(0)
  })

  it('keeps looks apart and ignores unknown releases', () => {
    const { log, looks } = cache()
    looks.acquire(DEFAULT_APPEARANCE)
    looks.acquire(blue)
    looks.release(lookKey(blue))
    looks.release(lookKey(blue))
    looks.release('avatar:9.9.9.9.9.9')
    expect(log).toEqual(['+avatar:0.0.0.0.0.0', '+avatar:0.0.0.6.0.0', '-avatar:0.0.0.6.0.0'])
    expect(looks.size).toBe(1)
  })
})
