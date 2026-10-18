export function requireElement<T extends HTMLElement>(id: string, ctor: new () => T): T {
  const el = document.getElementById(id)
  if (!(el instanceof ctor)) throw new Error(`#${id} is not a ${ctor.name}`)
  return el
}
