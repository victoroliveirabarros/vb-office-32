const TAG_MIN = 4
const TAG_MAX = 7

// Names that only differ in case or compatibility forms read as the same.
export function nameKey(name: string): string {
  return name.normalize('NFKC').trim().toLocaleLowerCase('pt-BR')
}

// FNV-1a over the id, in base 36: the same for every viewer. The leading
// digit is nearly always 0 or 1, so shorter tags take the end.
export function idTag(id: string, length = TAG_MAX): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(36).padStart(TAG_MAX, '0').slice(-length)
}

// The shortest tag length that tells the ids apart; 0 when none does.
function tagLength(ids: readonly string[]): number {
  for (let n = TAG_MIN; n <= TAG_MAX; n++) {
    if (new Set(ids.map((id) => idTag(id, n))).size === ids.length) return n
  }
  return 0
}

// Names labels people, adding a short tag derived from the id only to a name
// someone else also uses.
export class Names {
  private readonly byKey = new Map<string, Set<string>>()

  constructor(people: Iterable<readonly [id: string, name: string]>) {
    for (const [id, name] of people) {
      const key = nameKey(name)
      const ids = this.byKey.get(key)
      if (ids) ids.add(id)
      else this.byKey.set(key, new Set([id]))
    }
  }

  /** name as id shows it; id need not be among the people. */
  label(id: string, name: string): string {
    const ids = new Set(this.byKey.get(nameKey(name)))
    ids.add(id)
    if (ids.size === 1) return name
    const n = tagLength([...ids])
    return `${name} #${n === 0 ? id : idTag(id, n)}`
  }
}
