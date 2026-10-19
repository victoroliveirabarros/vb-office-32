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

export type ZoomShown = { level: number; min: number; max: number; manual: boolean }

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
  const status = requireElement('zoom-status', HTMLSpanElement)
  const game = requireElement('game', HTMLDivElement)
  let shown: number | null = null

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

      // Only Ctrl/⌘ + wheel (and the trackpad pinch, which arrives as one)
      // is ours; a plain wheel keeps its default.
      const wheel = new WheelSteps()
      game.addEventListener(
        'wheel',
        (e) => {
          if (!e.ctrlKey && !e.metaKey) return
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

    show({ level: zoom, min, max, manual }) {
      level.textContent = `${zoom}×`
      enable(zoomIn, zoom < max)
      enable(zoomOut, zoom > min)
      enable(reset, manual)
      if (shown !== null && shown !== zoom) status.textContent = `Zoom ${zoom}×`
      shown = zoom
    },
  }
}
