import Phaser from 'phaser'
import type { Dir } from '../net/protocol'
import type { Hud } from '../ui/hud'
import { AVATAR_KEY, MAP_KEY, TILE_SIZE, TILES_KEY } from './assets'

type TileStyle = { base: string; detail?: string; solid?: boolean }

const TILE_STYLES: readonly TileStyle[] = [
  { base: '#d9d3c5', detail: '#cbc4b4' },
  { base: '#4f6d99', detail: '#5b7aa6' },
  { base: '#454857', detail: '#5a5e70', solid: true },
  { base: '#8b5a2b', detail: '#a87040', solid: true },
  { base: '#3f8f4a', detail: '#7a5233', solid: true },
  { base: '#a63d40', detail: '#c25a5d', solid: true },
  { base: '#b7834f', detail: '#a3713f' },
  { base: '#2b3540', detail: '#7fb7d9', solid: true },
]

const AVATAR_EYES: Record<Dir, [number, number][]> = {
  down: [[11, 16], [19, 16]],
  left: [[8, 14]],
  right: [[22, 14]],
  up: [],
}

const AVATAR_FRAMES: readonly Dir[] = ['down', 'left', 'right', 'up']

export class BootScene extends Phaser.Scene {
  constructor(private readonly hud: Hud) {
    super('boot')
  }

  preload(): void {
    this.load.on(Phaser.Loader.Events.FILE_LOAD_ERROR, () => this.hud.setStatus('Falha ao carregar o mapa'))
    this.load.tilemapTiledJSON(MAP_KEY, `/maps/${MAP_KEY}.tmj`)
  }

  create(): void {
    if (!this.cache.tilemap.exists(MAP_KEY)) return
    this.createTilesTexture()
    this.createAvatarTexture()
    this.scene.start('office')
  }

  private createTilesTexture(): void {
    const texture = this.textures.createCanvas(TILES_KEY, TILE_SIZE * TILE_STYLES.length, TILE_SIZE)
    if (!texture) throw new Error('could not create tiles texture')
    const ctx = texture.context

    TILE_STYLES.forEach((style, i) => {
      const x = i * TILE_SIZE
      ctx.fillStyle = style.base
      ctx.fillRect(x, 0, TILE_SIZE, TILE_SIZE)
      if (style.detail) {
        ctx.fillStyle = style.detail
        ctx.fillRect(x + 8, 8, TILE_SIZE - 16, TILE_SIZE - 16)
      }
      if (style.solid) {
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.45)'
        ctx.strokeRect(x + 0.5, 0.5, TILE_SIZE - 1, TILE_SIZE - 1)
      }
    })
    texture.refresh()
  }

  private createAvatarTexture(): void {
    const texture = this.textures.createCanvas(AVATAR_KEY, TILE_SIZE * AVATAR_FRAMES.length, TILE_SIZE)
    if (!texture) throw new Error('could not create avatar texture')
    const ctx = texture.context

    AVATAR_FRAMES.forEach((frame, i) => {
      const cx = i * TILE_SIZE + TILE_SIZE / 2
      ctx.fillStyle = '#ffffff'
      ctx.strokeStyle = '#1b1b1f'
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.arc(cx, TILE_SIZE / 2 + 2, 11, 0, Math.PI * 2)
      ctx.fill()
      ctx.stroke()

      ctx.fillStyle = '#1b1b1f'
      for (const [ex, ey] of AVATAR_EYES[frame]) {
        ctx.fillRect(i * TILE_SIZE + ex, ey, 2, 3)
      }
      texture.add(frame, 0, i * TILE_SIZE, 0, TILE_SIZE, TILE_SIZE)
    })
    texture.refresh()
  }
}
