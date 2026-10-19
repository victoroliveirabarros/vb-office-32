import { AVATAR_PARTS_URL } from '../scenes/assets'

let parts: Promise<HTMLImageElement> | null = null

/** The parts atlas as an image, loaded once for the editor and the heads in the panels. */
export function loadParts(): Promise<HTMLImageElement> {
  if (!parts) {
    const img = new Image()
    img.src = AVATAR_PARTS_URL
    parts = img.decode().then(() => img)
    parts.catch(() => {
      parts = null
    })
  }
  return parts
}
