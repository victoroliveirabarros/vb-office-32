import Phaser from 'phaser'
import type { Dir } from '../net/protocol'
import type { Hud } from '../ui/hud'
import { AVATAR_KEY, MAP_KEY, TILE_SIZE, TILES_KEY, TILES_URL } from './assets'

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
    this.load.image(TILES_KEY, TILES_URL)
  }

  create(): void {
    if (!this.cache.tilemap.exists(MAP_KEY) || !this.textures.exists(TILES_KEY)) return
    this.createAvatarTexture()
    this.scene.start('office')
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
