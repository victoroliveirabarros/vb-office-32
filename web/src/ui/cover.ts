import type { CoverSource } from '../scenes/OfficeScene'

/** What an element over the map covers of it, while shown. */
export function coverOf(el: HTMLElement): CoverSource {
  return {
    rect() {
      const { x, y, width, height } = el.getBoundingClientRect()
      return width > 0 && height > 0 ? { x, y, width, height } : null
    },
    // A hidden element measures 0×0, so opening and closing count as resizes.
    onChange(fn) {
      const observer = new ResizeObserver(() => fn())
      observer.observe(el)
      return () => observer.disconnect()
    },
  }
}
