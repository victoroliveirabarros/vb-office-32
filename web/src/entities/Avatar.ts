import Phaser from 'phaser'
import type { Facing } from '../game/grid'
import type { Dir, Player } from '../net/protocol'
import { AVATAR_KEY, TILE_SIZE } from '../scenes/assets'

const SPEAKING_COLOR = 0x5ee27a
const LABEL_BG = 0x2b2420
const LABEL_ALPHA = 0.78
const LABEL_PAD_X = 5
const LABEL_PAD_Y = 1
const LABEL_BOTTOM = -TILE_SIZE / 2 - 2

export class Avatar extends Phaser.GameObjects.Container {
  private readonly sprite: Phaser.GameObjects.Image
  private readonly label: Phaser.GameObjects.Text
  private readonly labelBg: Phaser.GameObjects.Graphics
  private readonly ring: Phaser.GameObjects.Arc
  private motion: Phaser.Tweens.Tween | null = null
  private current: Facing

  constructor(scene: Phaser.Scene, player: Player) {
    super(scene, toPixel(player.x), toPixel(player.y))
    this.current = { x: player.x, y: player.y, dir: player.dir }

    this.sprite = scene.add.image(0, 0, AVATAR_KEY, player.dir).setTint(colorFor(player.id))
    this.labelBg = scene.add.graphics()
    this.label = scene.add
      .text(0, LABEL_BOTTOM - LABEL_PAD_Y, player.name, {
        fontFamily: '"Nunito", system-ui, sans-serif',
        fontSize: '11px',
        fontStyle: '700',
        color: '#ffffff',
        resolution: labelResolution(scene),
      })
      .setOrigin(0.5, 1)
    this.drawLabel()

    this.ring = scene.add.circle(0, 2, 14).setStrokeStyle(2, SPEAKING_COLOR).setVisible(false)

    this.add([this.ring, this.sprite, this.labelBg, this.label])
    this.setDepth(10)
    scene.add.existing(this)
  }

  get tile(): Facing {
    return this.current
  }

  setLabel(name: string): void {
    this.label.setResolution(labelResolution(this.scene))
    this.label.setText(name)
    this.drawLabel()
  }

  // Every text upload resets the filter to the game's NEAREST; the name is
  // drawn at screen resolution and reads best smoothed.
  private drawLabel(): void {
    this.label.texture.setFilter(Phaser.Textures.FilterMode.LINEAR)
    const w = Math.ceil(this.label.width) + LABEL_PAD_X * 2
    const h = Math.ceil(this.label.height) + LABEL_PAD_Y * 2
    this.labelBg
      .clear()
      .fillStyle(LABEL_BG, LABEL_ALPHA)
      .fillRoundedRect(-w / 2, LABEL_BOTTOM - h, w, h, h / 2)
  }

  // Makes the avatar clickable; fn runs on release so that focus moved by
  // it is not taken back by the press.
  onPick(fn: () => void): void {
    this.sprite.setInteractive({ useHandCursor: true })
    this.sprite.on(Phaser.Input.Events.GAMEOBJECT_POINTER_UP, fn)
  }

  setSpeaking(speaking: boolean): void {
    this.ring.setVisible(speaking)
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

function labelResolution(scene: Phaser.Scene): number {
  return Math.min(4, scene.cameras.main.zoom * window.devicePixelRatio)
}

function colorFor(id: string): number {
  let hash = 0
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  return Phaser.Display.Color.HSLToColor((hash % 360) / 360, 0.65, 0.6).color
}
