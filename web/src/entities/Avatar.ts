import Phaser from 'phaser'
import type { Facing } from '../game/grid'
import type { Dir, Player } from '../net/protocol'
import { AVATAR_KEY, TILE_SIZE } from '../scenes/assets'

export class Avatar extends Phaser.GameObjects.Container {
  private readonly sprite: Phaser.GameObjects.Image
  private readonly label: Phaser.GameObjects.Text
  private motion: Phaser.Tweens.Tween | null = null
  private current: Facing

  constructor(scene: Phaser.Scene, player: Player) {
    super(scene, toPixel(player.x), toPixel(player.y))
    this.current = { x: player.x, y: player.y, dir: player.dir }

    this.sprite = scene.add.image(0, 0, AVATAR_KEY, player.dir).setTint(colorFor(player.id))
    this.label = scene.add
      .text(0, -TILE_SIZE / 2 - 2, player.name, {
        fontFamily: 'monospace',
        fontSize: '10px',
        color: '#ffffff',
        stroke: '#000000',
        strokeThickness: 3,
        resolution: 4,
      })
      .setOrigin(0.5, 1)

    this.add([this.sprite, this.label])
    this.setDepth(10)
    scene.add.existing(this)
  }

  get tile(): Facing {
    return this.current
  }

  setLabel(name: string): void {
    this.label.setText(name)
  }

  face(dir: Dir): void {
    this.current = { ...this.current, dir }
    this.sprite.setFrame(dir)
  }

  walkTo(target: Facing, durationMs: number): void {
    this.face(target.dir)
    if (target.x === this.current.x && target.y === this.current.y) return

    this.current = { ...target }
    this.motion?.stop()
    this.motion = this.scene.tweens.add({
      targets: this,
      x: toPixel(target.x),
      y: toPixel(target.y),
      duration: durationMs,
      ease: 'Linear',
    })
  }

  snapTo(target: Facing): void {
    this.motion?.stop()
    this.motion = null
    this.face(target.dir)
    this.current = { ...target }
    this.setPosition(toPixel(target.x), toPixel(target.y))
  }
}

function toPixel(tile: number): number {
  return tile * TILE_SIZE + TILE_SIZE / 2
}

function colorFor(id: string): number {
  let hash = 0
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  return Phaser.Display.Color.HSLToColor((hash % 360) / 360, 0.65, 0.6).color
}
