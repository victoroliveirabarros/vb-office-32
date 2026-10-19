import type { CoverSource } from '../scenes/OfficeScene'

/**
 * What a panel covers of the map, in the map's own coordinates, while
 * shown beside it; a drawer over the map is modal and covers nothing.
 */
export function coverOf(el: HTMLElement, map: HTMLElement, docked: MediaQueryList): CoverSource {
  return {
    rect() {
      if (!docked.matches) return null
      const panel = el.getBoundingClientRect()
      const view = map.getBoundingClientRect()
      const x = Math.max(panel.x, view.x)
      const right = Math.min(panel.right, view.right)
      if (panel.width <= 0 || panel.height <= 0 || right <= x) return null
      return { x: x - view.x, y: panel.y - view.y, width: right - x, height: panel.height }
    },
    // A hidden element measures 0×0, so opening and closing count as resizes.
    onChange(fn) {
      const observer = new ResizeObserver(() => fn())
      observer.observe(el)
      docked.addEventListener('change', fn)
      return () => {
        observer.disconnect()
        docked.removeEventListener('change', fn)
      }
    },
  }
}
