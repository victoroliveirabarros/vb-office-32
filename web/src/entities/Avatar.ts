import Phaser from 'phaser'
import { DEFAULT_APPEARANCE, sameAppearance } from '../avatar/appearance'
import type { Appearance } from '../avatar/appearance'
import { FRAME_HEIGHT } from '../avatar/catalog.gen'
import { frameFor, frameIndex } from '../avatar/frames'
import type { LookCache } from '../avatar/looks'
import { keepOnScreen, textResolution } from '../game/zoom'
import type { Facing } from '../game/grid'
import type { Dir, Player } from '../net/protocol'
import { TILE_SIZE } from '../scenes/assets'

const SPEAKING_COLOR = 0x5ee27a
const LABEL_BG = 0x00263e
const LABEL_ALPHA = 0.85
const LABEL_PAD_X = 5
const LABEL_PAD_Y = 1
// The 16×24 art is drawn at 2×: feet on the bottom of the tile, the head in
// the tile above, the name just over it. Below 1× (the overview) the art
// keeps at least its own size on screen and the name its 1× size.
const SCALE = 2
const FEET = TILE_SIZE / 2
const NAME_GAP = 2
const RING_Y = FEET - 4
const DEPTH = 10
const { LINEAR, NEAREST } = Phaser.Textures.FilterMode

export class Avatar extends Phaser.GameObjects.Container {
  private readonly sprite: Phaser.GameObjects.Sprite
  private readonly label: Phaser.GameObjects.Text
  private readonly labelBg: Phaser.GameObjects.Graphics
  private readonly tag: Phaser.GameObjects.Container
  private readonly ring: Phaser.GameObjects.Ellipse
  private zoom: number
  private smooth = false
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
    this.zoom = scene.cameras.main.zoom

    this.ring = scene.add.ellipse(0, RING_Y, 24, 8).setStrokeStyle(2, SPEAKING_COLOR).setVisible(false)
    this.sprite = scene.add
      .sprite(0, FEET, this.lookKey)
      .setOrigin(0.5, 1)
    this.labelBg = scene.add.graphics()
    this.label = scene.add
      .text(0, -LABEL_PAD_Y, player.name, {
        fontFamily: '"Montserrat", system-ui, sans-serif',
        fontSize: '11px',
        fontStyle: '700',
        color: '#ffffff',
        resolution: this.labelResolution(),
      })
      .setOrigin(0.5, 1)
    this.tag = scene.add.container(0, 0, [this.labelBg, this.label])
    this.scaleTo(this.zoom)
    this.drawLabel()
    this.showFrame()

    this.add([this.ring, this.sprite, this.tag])
    this.updateDepth()
    scene.add.existing(this)
    this.once(Phaser.GameObjects.Events.DESTROY, () => looks.release(this.lookKey))
  }

  get tile(): Facing {
    return this.current
  }

  setLabel(name: string): void {
    this.label.setResolution(this.labelResolution())
    this.label.setText(name)
    this.drawLabel()
  }

  /**
   * Sizes the art and the name for the camera's zoom. Cheap enough for every
   * frame of a zoom; the name is redrawn sharp by refreshLabel once there.
   */
  scaleTo(zoom: number): void {
    this.zoom = zoom
    const art = keepOnScreen(SCALE, zoom)
    const name = keepOnScreen(1, zoom)
    this.sprite.setScale(art)
    this.ring.setScale(art / SCALE)
    this.tag.setScale(name).setY(FEET - FRAME_HEIGHT * art - NAME_GAP * name)
    // Art shown at a fractional scale is smoothed between its pixels.
    const onScreen = art * zoom
    this.setSmooth(zoom < 1 && Math.abs(onScreen - Math.round(onScreen)) > 0.01)
  }

  /** Redraws the name for the camera's current zoom. */
  refreshLabel(): void {
    this.label.setResolution(this.labelResolution())
    this.drawLabel()
  }

  setAppearance(look: Appearance): void {
    if (sameAppearance(look, this.look)) return
    const old = this.lookKey
    this.look = look
    this.lookKey = this.looks.acquire(look)
    this.frame = -1
    this.sprite.setTexture(this.lookKey)
    this.applySmooth()
    this.showFrame()
    this.looks.release(old)
  }

  // Every text upload resets the filter to the game's NEAREST; the name is
  // drawn at screen resolution and reads best smoothed.
  private drawLabel(): void {
    this.label.texture.setFilter(LINEAR)
    const w = Math.ceil(this.label.width) + LABEL_PAD_X * 2
    const h = Math.ceil(this.label.height) + LABEL_PAD_Y * 2
    this.labelBg
      .clear()
      .fillStyle(LABEL_BG, LABEL_ALPHA)
      .fillRoundedRect(-w / 2, -h, w, h, h / 2)
  }

  private labelResolution(): number {
    return textResolution(this.zoom * keepOnScreen(1, this.zoom), window.devicePixelRatio)
  }

  private setSmooth(smooth: boolean): void {
    if (smooth === this.smooth) return
    this.smooth = smooth
    this.applySmooth()
  }

  // Looks are shared, so every avatar wearing one sets it the same way.
  private applySmooth(): void {
    const texture = this.sprite.texture
    texture.setSmoothPixelArt(this.smooth)
    if (!this.smooth) texture.setFilter(NEAREST)
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
