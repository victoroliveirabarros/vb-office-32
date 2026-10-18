import { describe, expect, it } from 'vitest'
import { deviceButton } from './media'

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
