import Phaser from 'phaser'
import { DEFAULT_APPEARANCE, sameAppearance } from '../avatar/appearance'
import type { Appearance } from '../avatar/appearance'
import { frameFor, frameIndex } from '../avatar/frames'
import type { LookCache } from '../avatar/looks'
import { textResolution } from '../game/zoom'
import type { Facing } from '../game/grid'
import type { Dir, Player } from '../net/protocol'
import { TILE_SIZE } from '../scenes/assets'

const SPEAKING_COLOR = 0x5ee27a
const LABEL_BG = 0x00263e
const LABEL_ALPHA = 0.85
const LABEL_PAD_X = 5
const LABEL_PAD_Y = 1
// The 16×24 art is drawn at 2×: feet on the bottom of the tile, the head in
// the tile above, the name just over it.
const SCALE = 2
const FEET = TILE_SIZE / 2
const LABEL_BOTTOM = -34
const RING_Y = FEET - 4
const DEPTH = 10

export class Avatar extends Phaser.GameObjects.Container {
  private readonly sprite: Phaser.GameObjects.Sprite
  private readonly label: Phaser.GameObjects.Text
  private readonly labelBg: Phaser.GameObjects.Graphics
  private readonly ring: Phaser.GameObjects.Ellipse
  private motion: Phaser.Tweens.Tween | null = null
  private current: Facing
  private look: Appearance
  private lookKey: string
  private stride = 0
  private frame = -1

  constructor(
    scene: Phaser.Scene,
    player: Player,
    private readonly looks: LookCache,
  ) {
    super(scene, toPixel(player.x), toPixel(player.y))
    this.current = { x: player.x, y: player.y, dir: player.dir }
    this.look = player.appearance ?? DEFAULT_APPEARANCE
    this.lookKey = looks.acquire(this.look)

    this.ring = scene.add.ellipse(0, RING_Y, 24, 8).setStrokeStyle(2, SPEAKING_COLOR).setVisible(false)
    this.sprite = scene.add
      .sprite(0, FEET, this.lookKey)
      .setOrigin(0.5, 1)
      .setScale(SCALE)
    this.labelBg = scene.add.graphics()
    this.label = scene.add
      .text(0, LABEL_BOTTOM - LABEL_PAD_Y, player.name, {
        fontFamily: '"Montserrat", system-ui, sans-serif',
        fontSize: '11px',
        fontStyle: '700',
        color: '#ffffff',
        resolution: labelResolution(scene),
      })
      .setOrigin(0.5, 1)
    this.drawLabel()
    this.showFrame()

    this.add([this.ring, this.sprite, this.labelBg, this.label])
    this.updateDepth()
    scene.add.existing(this)
    this.once(Phaser.GameObjects.Events.DESTROY, () => looks.release(this.lookKey))
  }

  get tile(): Facing {
    return this.current
  }

  setLabel(name: string): void {
    this.label.setResolution(labelResolution(this.scene))
    this.label.setText(name)
    this.drawLabel()
  }

  /** Redraws the name for the camera's current zoom. */
  refreshLabel(): void {
    this.label.setResolution(labelResolution(this.scene))
    this.drawLabel()
  }

  setAppearance(look: Appearance): void {
    if (sameAppearance(look, this.look)) return
    const old = this.lookKey
    this.look = look
    this.lookKey = this.looks.acquire(look)
    this.frame = -1
    this.sprite.setTexture(this.lookKey)
    this.showFrame()
    this.looks.release(old)
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

  // Turning mid-step keeps the foot that is forward.
  face(dir: Dir): void {
    this.current = { ...this.current, dir }
    this.showFrame()
  }

  walkTo(target: Facing, durationMs: number): void {
    if (target.x === this.current.x && target.y === this.current.y) {
      this.face(target.dir)
      return
    }

    this.current = { ...target }
    this.stride++
    this.motion?.stop()
    this.motion = this.scene.tweens.add({
      targets: this,
      x: toPixel(target.x),
      y: toPixel(target.y),
      duration: durationMs,
      ease: 'Linear',
      onUpdate: () => {
        this.updateDepth()
        this.showFrame()
      },
      onComplete: () => {
        this.motion = null
        this.showFrame()
      },
    })
    this.showFrame()
  }

  snapTo(target: Facing): void {
    this.motion?.stop()
    this.motion = null
    this.current = { ...target }
    this.setPosition(toPixel(target.x), toPixel(target.y))
    this.updateDepth()
    this.showFrame()
  }

  private showFrame(): void {
    const { dir } = this.current
    const frame = this.motion ? frameFor(dir, this.stride, this.motion.progress) : frameIndex(dir, 0)
    if (frame === this.frame) return
    this.frame = frame
    this.sprite.setFrame(frame)
  }

  // Lower on the map is nearer: drawn over who stands above.
  private updateDepth(): void {
    this.setDepth(DEPTH + this.y)
  }
}

function toPixel(tile: number): number {
  return tile * TILE_SIZE + TILE_SIZE / 2
}

function labelResolution(scene: Phaser.Scene): number {
  return textResolution(scene.cameras.main.zoom, window.devicePixelRatio)
}
