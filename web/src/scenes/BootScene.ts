import Phaser from 'phaser'
import { FRAME_HEIGHT, FRAME_WIDTH } from '../avatar/catalog.gen'
import type { Hud } from '../ui/hud'
import { AVATAR_PARTS_KEY, AVATAR_PARTS_URL, MAP_KEY, TILES_KEY, TILES_URL } from './assets'

export class BootScene extends Phaser.Scene {
  constructor(private readonly hud: Hud) {
    super('boot')
  }

  preload(): void {
    this.load.on(Phaser.Loader.Events.FILE_LOAD_ERROR, () => this.hud.setStatus('Falha ao carregar o mapa'))
    this.load.tilemapTiledJSON(MAP_KEY, `/maps/${MAP_KEY}.tmj`)
    this.load.image(TILES_KEY, TILES_URL)
    this.load.spritesheet(AVATAR_PARTS_KEY, AVATAR_PARTS_URL, { frameWidth: FRAME_WIDTH, frameHeight: FRAME_HEIGHT })
  }

  create(): void {
    if (!this.cache.tilemap.exists(MAP_KEY) || !this.textures.exists(TILES_KEY) || !this.textures.exists(AVATAR_PARTS_KEY)) return
    this.scene.start('office')
  }
}
