import { WheelSteps, zoomKey } from '../game/zoom'
import { requireElement } from './dom'

export type ZoomActions = {
  step(delta: 1 | -1): void
  reset(): void
  pinchStart(): void
  pinch(ratio: number): void
  pinchEnd(): void
  /** False while the chat or the avatar editor holds the keyboard. */
  keyboardFree(): boolean
}

export type ZoomShown = { level: number; overview: boolean; canIn: boolean; canOut: boolean; manual: boolean }

export type ZoomView = {
  /** Shows the controls and wires the gestures; the returned function undoes it. */
  bind(actions: ZoomActions): () => void
  show(state: ZoomShown): void
}

function distance(touches: TouchList): number {
  const [a, b] = [touches[0], touches[1]]
  return a && b ? Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) : 0
}

export function createZoomControls(): ZoomView {
  const root = requireElement('zoom', HTMLDivElement)
  const zoomIn = requireElement('zoom-in', HTMLButtonElement)
  const zoomOut = requireElement('zoom-out', HTMLButtonElement)
  const reset = requireElement('zoom-reset', HTMLButtonElement)
  const level = requireElement('zoom-level', HTMLSpanElement)
  const value = requireElement('zoom-level-value', HTMLSpanElement)
  const status = requireElement('zoom-status', HTMLSpanElement)
  const game = requireElement('game', HTMLDivElement)
  let shown: string | null = null

  // aria-disabled keeps a button that hits a limit focused.
  const enable = (button: HTMLButtonElement, on: boolean) => button.setAttribute('aria-disabled', String(!on))
  const enabled = (button: HTMLButtonElement) => button.getAttribute('aria-disabled') !== 'true'

  return {
    bind(actions) {
      const ac = new AbortController()
      const { signal } = ac
      const click = (button: HTMLButtonElement, fn: () => void) =>
        button.addEventListener(
          'click',
          () => {
            if (enabled(button)) fn()
          },
          { signal },
        )
      click(zoomIn, () => actions.step(1))
      click(zoomOut, () => actions.step(-1))
      click(reset, () => actions.reset())

      window.addEventListener(
        'keydown',
        (e) => {
          if (!actions.keyboardFree()) return
          const target = e.target instanceof HTMLElement ? e.target : null
          switch (zoomKey(e, target)) {
            case 'in':
              return actions.step(1)
            case 'out':
              return actions.step(-1)
            case 'reset':
              return actions.reset()
          }
        },
        { signal },
      )

      // Over the map every wheel zooms: a plain one, Ctrl/⌘ + wheel and the
      // trackpad pinch, which arrives as one. The chat and the panels lie
      // outside #game and keep their scrolling.
      const wheel = new WheelSteps()
      game.addEventListener(
        'wheel',
        (e) => {
          e.preventDefault()
          const step = wheel.push(e.deltaY, e.deltaMode, e.timeStamp)
          if (step !== 0) actions.step(step)
        },
        { passive: false, signal },
      )

      // Phaser already cancels the browser's own handling of touches on the
      // canvas; a second finger starts (or restarts) a pinch.
      let from = 0
      let pinching = false
      game.addEventListener(
        'touchstart',
        (e) => {
          if (e.touches.length !== 2) return
          from = distance(e.touches)
          if (from <= 0) return
          pinching = true
          actions.pinchStart()
        },
        { passive: true, signal },
      )
      game.addEventListener(
        'touchmove',
        (e) => {
          if (pinching && e.touches.length >= 2) actions.pinch(distance(e.touches) / from)
        },
        { passive: true, signal },
      )
      const end = (e: TouchEvent) => {
        if (!pinching || e.touches.length > 0) return
        pinching = false
        actions.pinchEnd()
      }
      game.addEventListener('touchend', end, { passive: true, signal })
      game.addEventListener('touchcancel', end, { passive: true, signal })

      root.hidden = false
      return () => {
        ac.abort()
        root.hidden = true
        shown = null
      }
    },

    show({ level: zoom, overview, canIn, canOut, manual }) {
      const label = overview ? 'Visão geral' : `${zoom}×`
      value.textContent = overview ? '' : label
      level.toggleAttribute('data-overview', overview)
      level.title = overview ? 'Visão geral do escritório' : ''
      enable(zoomIn, canIn)
      enable(zoomOut, canOut)
      enable(reset, manual)
      if (shown !== null && shown !== label) status.textContent = overview ? 'Visão geral do escritório' : `Zoom ${zoom}×`
      shown = label
    },
  }
}
