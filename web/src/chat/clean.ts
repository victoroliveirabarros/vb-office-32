// Mirrors internal/chat.Clean so the counter and the send button agree with
// the server; the server still cleans and decides.

export const MAX_RUNES = 500
export const MAX_LINES = 20

export type CleanError = 'empty' | 'too_long'

export type Cleaned = { text: string; runes: number; error: CleanError | null }

const ZWNJ = 0x200c
const ZWJ = 0x200d
const CF = /^\p{Cf}$/u

export function clean(raw: string): Cleaned {
  const text = cleanText(raw)
  const runes = Array.from(text).length
  let error: CleanError | null = null
  if (runes === 0) error = 'empty'
  else if (runes > MAX_RUNES || lineCount(text) > MAX_LINES) error = 'too_long'
  return { text, runes, error }
}

function cleanText(raw: string): string {
  const runes = Array.from(raw, wellFormed)
    .join('')
    .replace(/\r\n|[\r\u0085\u{2028}\u{2029}]/gu, '\n')
    .replace(/\t/g, ' ')
  const kept = Array.from(runes).filter((r) => isJoiner(cp(r)) || !(isControl(cp(r)) || isFormat(r)))

  let out = ''
  let prev = -1
  kept.forEach((r, i) => {
    const c = cp(r)
    if (isJoiner(c) && !joins(prev, kept, i + 1)) return
    out += r
    prev = c
  })

  return trimSpace(
    out
      .split('\n')
      .map(trimSpaceEnd)
      .join('\n')
      .replace(/\n{4,}/g, '\n\n\n'),
  )
}

// A joiner survives only between two non-space runes after a non-ASCII one:
// emoji sequences, the Persian ZWNJ. Repeated joiners collapse into the first.
function joins(prev: number, runes: readonly string[], from: number): boolean {
  if (prev < 0x80 || isSpace(prev) || isFormatCode(prev)) return false
  for (let i = from; i < runes.length; i++) {
    const c = cp(runes[i] ?? '')
    if (!isJoiner(c)) return !isSpace(c)
  }
  return false
}

function isJoiner(c: number): boolean {
  return c === ZWJ || c === ZWNJ
}

function wellFormed(r: string): string {
  const c = cp(r)
  return c >= 0xd800 && c <= 0xdfff ? '�' : r
}

function isControl(c: number): boolean {
  return c !== 0x0a && (c < 0x20 || (c >= 0x7f && c <= 0x9f))
}

function isFormat(r: string): boolean {
  return CF.test(r)
}

function isFormatCode(c: number): boolean {
  return c >= 0 && isFormat(String.fromCodePoint(c))
}

// unicode.IsSpace from Go.
export function isSpace(c: number): boolean {
  switch (c) {
    case 0x09:
    case 0x0a:
    case 0x0b:
    case 0x0c:
    case 0x0d:
    case 0x20:
    case 0x85:
    case 0xa0:
    case 0x1680:
    case 0x2028:
    case 0x2029:
    case 0x202f:
    case 0x205f:
    case 0x3000:
      return true
  }
  return c >= 0x2000 && c <= 0x200a
}

function trimSpaceEnd(s: string): string {
  const runes = Array.from(s)
  let end = runes.length
  while (end > 0 && isSpace(cp(runes[end - 1] ?? ''))) end--
  return runes.slice(0, end).join('')
}

function trimSpace(s: string): string {
  const runes = Array.from(s)
  let start = 0
  while (start < runes.length && isSpace(cp(runes[start] ?? ''))) start++
  let end = runes.length
  while (end > start && isSpace(cp(runes[end - 1] ?? ''))) end--
  return runes.slice(start, end).join('')
}

function lineCount(s: string): number {
  let n = 1
  for (const ch of s) if (ch === '\n') n++
  return n
}

function cp(r: string): number {
  return r.codePointAt(0) ?? -1
}
