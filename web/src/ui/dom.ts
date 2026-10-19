export function requireElement<T extends HTMLElement>(id: string, ctor: new () => T): T {
  const el = document.getElementById(id)
  if (!(el instanceof ctor)) throw new Error(`#${id} is not a ${ctor.name}`)
  return el
}

const SVG_NS = 'http://www.w3.org/2000/svg'

/** An icon from the sprite in public/icons.svg, hidden from assistive tech. */
export function icon(name: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('class', 'icon')
  svg.setAttribute('aria-hidden', 'true')
  const use = document.createElementNS(SVG_NS, 'use')
  use.setAttribute('href', `/icons.svg#${name}`)
  svg.append(use)
  return svg
}
