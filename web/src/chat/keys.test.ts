import { describe, expect, it } from 'vitest'
import { atBottom, inputAction, isComposing, isEditable, shouldFocusChat } from './keys'

const body = { tagName: 'BODY' }
const canvas = { tagName: 'CANVAS' }

describe('isEditable', () => {
  it('knows form fields and contenteditable', () => {
    for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) expect(isEditable({ tagName })).toBe(true)
    expect(isEditable({ tagName: 'DIV', isContentEditable: true })).toBe(true)
    for (const target of [null, body, canvas, { tagName: 'BUTTON' }]) expect(isEditable(target)).toBe(false)
  })
})

describe('shouldFocusChat', () => {
  it('takes a bare Enter on the page or the game', () => {
    expect(shouldFocusChat({ key: 'Enter' }, body)).toBe(true)
    expect(shouldFocusChat({ key: 'Enter' }, canvas)).toBe(true)
    expect(shouldFocusChat({ key: 'Enter' }, null)).toBe(true)
  })

  it('leaves other keys and modified Enter alone', () => {
    expect(shouldFocusChat({ key: 'd' }, body)).toBe(false)
    for (const mod of ['shiftKey', 'ctrlKey', 'altKey', 'metaKey']) expect(shouldFocusChat({ key: 'Enter', [mod]: true }, body)).toBe(false)
    expect(shouldFocusChat({ key: 'Enter', defaultPrevented: true }, body)).toBe(false)
  })

  it('leaves Enter to fields and controls that use it', () => {
    for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'A', 'SUMMARY']) {
      expect(shouldFocusChat({ key: 'Enter' }, { tagName })).toBe(false)
    }
    expect(shouldFocusChat({ key: 'Enter' }, { tagName: 'DIV', isContentEditable: true })).toBe(false)
  })

  it('ignores an IME confirming its composition', () => {
    expect(shouldFocusChat({ key: 'Enter', isComposing: true }, body)).toBe(false)
    expect(shouldFocusChat({ key: 'Process', keyCode: 229 }, body)).toBe(false)
    expect(isComposing({ key: 'Enter', keyCode: 229 })).toBe(true)
  })
})

describe('inputAction', () => {
  it('sends on Enter and leaves on Escape', () => {
    expect(inputAction({ key: 'Enter' })).toBe('send')
    expect(inputAction({ key: 'Escape' })).toBe('leave')
  })

  it('lets Shift+Enter break the line and the IME finish', () => {
    expect(inputAction({ key: 'Enter', shiftKey: true })).toBeNull()
    expect(inputAction({ key: 'Enter', isComposing: true })).toBeNull()
    expect(inputAction({ key: 'Enter', keyCode: 229 })).toBeNull()
    expect(inputAction({ key: 'Escape', isComposing: true })).toBeNull()
    expect(inputAction({ key: 'a' })).toBeNull()
  })
})

describe('atBottom', () => {
  it('allows a few pixels of slack', () => {
    expect(atBottom({ scrollTop: 600, scrollHeight: 1000, clientHeight: 400 })).toBe(true)
    expect(atBottom({ scrollTop: 594, scrollHeight: 1000, clientHeight: 400 })).toBe(true)
    expect(atBottom({ scrollTop: 500, scrollHeight: 1000, clientHeight: 400 })).toBe(false)
    expect(atBottom({ scrollTop: 0, scrollHeight: 100, clientHeight: 400 })).toBe(true)
  })
})
