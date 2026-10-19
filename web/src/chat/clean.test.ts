import { describe, expect, it } from 'vitest'
import { clean, MAX_RUNES } from './clean'

describe('clean', () => {
  it('keeps plain text, accents and HTML literally', () => {
    for (const text of ['olá, ação!', '<b>oi</b> & <script>alert(1)</script>', '"aspas" \'simples\'']) {
      expect(clean(text)).toEqual({ text, runes: Array.from(text).length, error: null })
    }
  })

  it('keeps composed emoji whole', () => {
    for (const text of ['👨\u{200D}👩\u{200D}👧\u{200D}👦', '🏳\u{FE0F}\u{200D}🌈', '👍\u{1F3FD}', '🇧🇷🇵🇹', '#\u{FE0F}\u{20E3}', 'می\u{200C}خواهم', '🧑\u{1F3FF}\u{200D}💻 ok']) {
      expect(clean(text).text).toBe(text)
    }
  })

  it('drops bidi overrides, BOM, soft hyphens and tags', () => {
    expect(clean('abc\u{202E}gpj.exe').text).toBe('abcgpj.exe')
    expect(clean('\u{2066}x\u{2069}\u{200E}\u{200F}\u{61C}').text).toBe('x')
    expect(clean('\u{FEFF}in\u{AD}visível').text).toBe('invisível')
    expect(clean('🏴\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}').text).toBe('🏴')
  })

  it('drops stray, repeated and ASCII-adjacent joiners', () => {
    expect(clean('a\u{200D}b').text).toBe('ab')
    expect(clean('\u{200D}👍').text).toBe('👍')
    expect(clean('👍\u{200D}').text).toBe('👍')
    expect(clean('👍\u{200D} 👍').text).toBe('👍 👍')
    expect(clean('👨\u{200D}\u{200D}👩').text).toBe('👨\u{200D}👩')
    expect(clean('👨\u{200D}\u{202E}👩').text).toBe('👨\u{200D}👩')
    expect(clean('👨\u{200D}\u{200C}👩').text).toBe('👨\u{200D}👩')
    expect(clean('👨\u{200D}\u{200D}').text).toBe('👨')
  })

  it('removes controls but keeps newlines', () => {
    expect(clean('a\u0000b\u0007c\u001Bd\u007Fe\u0085f\u009Fg').text).toBe('abcde\nfg')
    expect(clean('a\tb').text).toBe('a b')
  })

  it('normalizes line breaks and squeezes blank lines', () => {
    expect(clean('a\r\nb\rc\u{2028}d\u{2029}e').text).toBe('a\nb\nc\nd\ne')
    expect(clean('a\n\n\n\n\n\nb').text).toBe('a\n\n\nb')
    expect(clean('a   \n  \n \n\t\n\nb  ').text).toBe('a\n\n\nb')
    expect(clean('  \n  oi  \n  ').text).toBe('oi')
    expect(clean('  recuo\nmantido').text).toBe('recuo\nmantido')
  })

  it('treats blank letters as spaces, like the server', () => {
    expect(clean('a\u{3164}b\u{2800}c\u{115F}d\u{1160}e\u{FFA0}f').text).toBe('a b c d e f')
    expect(clean('\u{3164}\u{2800}oi\u{FFA0}\n\u{115F}').text).toBe('oi')
    expect(clean('\u{3164}\u{2800}\u{115F}\u{1160}\u{FFA0}\n\u{3164}').error).toBe('empty')
  })

  it('replaces lone surrogates as JSON decoding would', () => {
    expect(clean('a\uD800b').text).toBe('a�b')
  })

  it('reports empty text', () => {
    for (const text of ['', '   ', '\n\n', '\u{200B}\u{202E}', '\u0000\t']) expect(clean(text).error).toBe('empty')
  })

  it('counts runes, not UTF-16 units', () => {
    const emoji = '😀'.repeat(MAX_RUNES)
    expect(clean(emoji)).toMatchObject({ runes: MAX_RUNES, error: null })
    expect(clean(emoji + '😀')).toMatchObject({ runes: MAX_RUNES + 1, error: 'too_long' })
    expect(clean('a'.repeat(MAX_RUNES) + '   ').error).toBeNull()
  })

  it('limits the number of lines', () => {
    expect(clean(Array(20).fill('x').join('\n')).error).toBeNull()
    expect(clean(Array(21).fill('x').join('\n')).error).toBe('too_long')
  })

  it('is idempotent', () => {
    const samples = ['👨\u{200D}\u{202E}👩', ' a \u{200D}\n\n\n\n\u{200D}b ', 'é\u{200D}\u{200D}\u{200D}ü', '\u{A0}x\u{3000}', 'a\uDC00\u{200D}']
    for (const raw of samples) {
      const once = clean(raw).text
      expect(clean(once).text).toBe(once)
    }
  })
})
