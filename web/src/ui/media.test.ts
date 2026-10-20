import { describe, expect, it } from 'vitest'
import { deviceButton, screenButton, screenError } from './media'

describe('deviceButton', () => {
  const on = { on: true, busy: false, error: null }

  it('shows the device state while the link is up', () => {
    expect(deviceButton(on, false, 'câmera')).toEqual({ pressed: true, disabled: false, error: false, label: 'Desligar câmera' })
    expect(deviceButton({ on: false, busy: true, error: 'denied' }, false, 'câmera')).toEqual({
      pressed: false,
      disabled: true,
      error: true,
      label: 'Ligar câmera',
    })
  })

  it('shows devices off and disabled once stopped', () => {
    expect(deviceButton(on, true, 'câmera')).toEqual({ pressed: false, disabled: true, error: false, label: 'Ligar câmera' })
  })
})

describe('screenButton', () => {
  const off = { on: false, busy: false, error: null, inZone: true, desk: false, taken: false }

  it('offers sharing only inside a zone while connected', () => {
    expect(screenButton(off, 'connected')).toMatchObject({ hidden: false, disabled: false, text: 'Compartilhar tela' })
    expect(screenButton(off, 'reconnecting')).toMatchObject({ hidden: false, disabled: true })
    expect(screenButton({ ...off, inZone: false }, 'connected').hidden).toBe(true)
    expect(screenButton(off, 'stopped').hidden).toBe(true)
  })

  it('is disabled while someone else in the room shares', () => {
    expect(screenButton({ ...off, taken: true }, 'connected')).toEqual({
      hidden: false,
      disabled: true,
      text: 'Compartilhar tela',
      title: 'Alguém da sala já está compartilhando',
    })
  })

  it('says mesa at a desk, sala anywhere else', () => {
    expect(screenButton(off, 'connected').title).toBe('Compartilhar tela com quem está na sala')
    expect(screenButton({ ...off, desk: true }, 'connected').title).toBe('Compartilhar tela com quem está na mesa')
    expect(screenButton({ ...off, desk: true, taken: true }, 'connected').title).toBe('Alguém da mesa já está compartilhando')
    expect(screenError({ ...off, error: 'taken' })).toBe('Outra pessoa da sala começou a compartilhar antes')
    expect(screenError({ ...off, desk: true, error: 'taken' })).toBe('Outra pessoa da mesa começou a compartilhar antes')
    expect(screenError({ ...off, error: 'denied' })).toBe('Compartilhamento de tela bloqueado')
    expect(screenError(off)).toBe('')
  })

  it('always lets a share be stopped', () => {
    expect(screenButton({ ...off, on: true, inZone: false, taken: true }, 'reconnecting')).toMatchObject({
      hidden: false,
      disabled: false,
      text: 'Parar',
    })
    expect(screenButton({ ...off, on: true, busy: true }, 'connected').disabled).toBe(true)
  })
})
