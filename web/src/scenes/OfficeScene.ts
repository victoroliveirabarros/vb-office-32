import Phaser from 'phaser'
import type { Appearance } from '../avatar/appearance'
import { FRAME_HEIGHT, FRAME_WIDTH } from '../avatar/catalog.gen'
import { composeStrip } from '../avatar/compose'
import { FRAME_COUNT } from '../avatar/frames'
import { LookCache } from '../avatar/looks'
import type { LookStore } from '../avatar/looks'
import { TypingOwners } from '../chat/keys'
import type { TypingGate, TypingOwner } from '../chat/keys'
import { Names } from '../chat/names'
import { Avatar } from '../entities/Avatar'
import { Grid } from '../game/grid'
import { Predictor, correctionFor } from '../game/prediction'
import { ZoneMap } from '../game/zones'
import { cameraBounds, textResolution, Zoom, zoomPrefs } from '../game/zoom'
import type { Size } from '../game/zoom'
import type { MapZone } from '../game/zones'
import type { Connection } from '../net/connection'
import type { Dir, Player, Pos, ServerMessage, State, Welcome } from '../net/protocol'
import type { Hud } from '../ui/hud'
import type { ZoomView } from '../ui/zoom'
import { AVATAR_PARTS_KEY, MAP_KEY, TILE_SIZE, TILES_KEY, TILESET_NAME } from './assets'

const PING_INTERVAL_MS = 2000
const DEFAULT_STEP_MS = 150
const ZOOM_MS = 180
// A finger lifted right after a pinch is not a click on an avatar.
const PICK_AFTER_PINCH_MS = 300

type DirKeys = Record<Dir, Phaser.Input.Keyboard.Key[]>

export type SpeakingSource = {
  onSpeaking(fn: (ids: ReadonlySet<string>) => void): () => void
}

export type SceneHooks = {
  speakers?: SpeakingSource
  /** The map's zones, once loaded. */
  zonesLoaded?(zones: ZoneMap): void
  /** Someone else's avatar was clicked. */
  picked?(id: string): void
  zoom?: ZoomView
}

const ZONE_COLORS: Record<MapZone['kind'], number> = { meeting: 0x014c8b, private: 0x7a3fb0 }
// Yellow reads on every room's floor: blue and slate carpets, rubber.
const ACCENT = 0xfdc339
const SIGN_HEIGHT = 16

type ZoneView = {
  zone: MapZone
  outline: Phaser.GameObjects.Graphics
  sign: Phaser.GameObjects.Container
  label: Phaser.GameObjects.Text
}

export class OfficeScene extends Phaser.Scene implements TypingGate {
  private grid!: Grid
  private keys!: DirKeys
  private readonly avatars = new Map<string, Avatar>()
  private readonly names = new Map<string, string>()
  private labels = new Names([])
  private zoneViews: ZoneView[] = []
  private zoneId = ''
  private selfId: string | null = null
  private predictor: Predictor | null = null
  private stepMs = DEFAULT_STEP_MS
  private nextStepAt = 0
  private speaking: ReadonlySet<string> = new Set()
  private readonly typing = new TypingOwners()
  private readonly looks = new LookCache(this.lookStore())
  private readonly zoomPrefs = zoomPrefs()
  private zoom!: Zoom
  private mapSize: Size = { width: 0, height: 0 }
  private pinchEndedAt = -Infinity

  constructor(
    private readonly connection: Connection,
    private readonly hud: Hud,
    private readonly hooks: SceneHooks = {},
  ) {
    super('office')
  }

  create(): void {
    const map = this.make.tilemap({ key: MAP_KEY })
    const tileset = map.addTilesetImage(TILESET_NAME, TILES_KEY)
    if (!tileset) throw new Error(`tileset "${TILESET_NAME}" missing from map`)
    map.createLayer('floor', tileset)?.setDepth(0)
    map.createLayer('walls', tileset)?.setDepth(2)
    map.createLayer('decor', tileset)?.setDepth(3)

    const cached: { data: unknown } = this.cache.tilemap.get(MAP_KEY)
    this.grid = Grid.fromTiled(cached.data)
    const zones = ZoneMap.fromTiled(cached.data)
    this.drawZones(zones)
    this.hooks.zonesLoaded?.(zones)

    this.mapSize = { width: map.widthInPixels, height: map.heightInPixels }
    this.zoom = new Zoom(this.mapSize, this.viewSize(), this.zoomPrefs.load())
    this.applyZoom(false)
    this.scale.on(Phaser.Scale.Events.RESIZE, this.resized, this)
    const offZoom = this.hooks.zoom?.bind({
      step: (delta) => this.zoomBy(() => this.zoom.step(delta)),
      reset: () => this.zoomBy(() => this.zoom.reset()),
      pinchStart: () => this.zoom.startPinch(),
      pinch: (ratio) => this.zoomBy(() => this.zoom.pinch(ratio)),
      pinchEnd: () => {
        this.zoom.endPinch()
        this.pinchEndedAt = this.time.now
      },
      keyboardFree: () => !this.typing.typing,
    })

    this.keys = this.createKeys()
    this.applyTyping()
    // Overlapping avatars: a click picks the one drawn on top.
    this.input.topOnly = true

    const offMessage = this.connection.onMessage((msg) => this.handle(msg))
    const offStatus = this.connection.onStatus((status) => {
      if (status !== 'open') this.predictor = null
    })
    const offSpeaking = this.hooks.speakers?.onSpeaking((ids) => this.showSpeaking(ids))
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      offMessage()
      offStatus()
      offSpeaking?.()
      offZoom?.()
      this.scale.off(Phaser.Scale.Events.RESIZE, this.resized, this)
    })

    this.time.addEvent({
      delay: PING_INTERVAL_MS,
      loop: true,
      callback: () => this.connection.send({ t: 'ping', d: { ts: performance.now() } }),
    })

    this.connection.connect()
  }

  // addKey makes Phaser call preventDefault on window keydowns even with the
  // plugin disabled, so typing also turns the global capture off; resetKeys
  // drops keys held when the chat took focus, whose keyup it will swallow.
  setTyping(owner: TypingOwner, on: boolean): void {
    if (this.typing.set(owner, on)) this.applyTyping()
  }

  update(time: number): void {
    if (this.typing.typing) return
    if (!this.predictor || !this.connection.isOpen || time < this.nextStepAt) return
    const dir = this.heldDir()
    if (!dir) return

    const move = this.predictor.input(dir)
    if (!move) return

    this.connection.send({ t: 'move', d: move })
    this.nextStepAt = time + this.stepMs
    this.self()?.walkTo(this.predictor.position, this.stepMs)
  }

  private handle(msg: ServerMessage): void {
    switch (msg.t) {
      case 'welcome':
        return this.onWelcome(msg.d)
      case 'joined':
        this.upsert(msg.d)
        return this.relabel()
      case 'left':
        this.avatars.get(msg.d.id)?.destroy()
        this.avatars.delete(msg.d.id)
        this.names.delete(msg.d.id)
        return this.relabel()
      case 'state':
        return this.onState(msg.d)
      case 'zone':
        this.zoneId = msg.d.id
        return this.highlightZone()
      case 'pong':
        return this.hud.setLatency(performance.now() - msg.d.ts)
      case 'appearance':
        return this.avatars.get(msg.d.id)?.setAppearance(msg.d.appearance)
    }
  }

  private onWelcome(welcome: Welcome): void {
    this.avatars.forEach((avatar) => avatar.destroy())
    this.avatars.clear()
    this.names.clear()
    this.stepMs = welcome.stepMs
    this.selfId = welcome.selfId
    welcome.players.forEach((player) => this.upsert(player))
    this.relabel()

    const self = welcome.players.find((p) => p.id === welcome.selfId)
    const avatar = this.self()
    if (!self || !avatar) return
    this.predictor = new Predictor(this.grid, self)
    this.cameras.main.startFollow(avatar, true)
  }

  private onState(state: State): void {
    let selfPos: Pos | undefined
    for (const pos of state.players) {
      if (pos.id === this.selfId) {
        selfPos = pos
        continue
      }
      const avatar = this.avatars.get(pos.id)
      if (!avatar) continue
      if (correctionFor(avatar.tile, pos) === 'snap') avatar.snapTo(pos)
      else avatar.walkTo(pos, this.stepMs)
    }

    const avatar = this.self()
    if (!this.predictor || !avatar) return
    const target = this.predictor.reconcile(state.ack, selfPos)
    switch (correctionFor(avatar.tile, target)) {
      case 'none':
        return avatar.face(target.dir)
      case 'tween':
        return avatar.walkTo(target, this.stepMs)
      case 'snap':
        return avatar.snapTo(target)
    }
  }

  private upsert(player: Player): void {
    this.names.set(player.id, player.name)
    const existing = this.avatars.get(player.id)
    if (existing) {
      existing.snapTo(player)
      if (player.appearance) existing.setAppearance(player.appearance)
      return
    }
    const avatar = new Avatar(this, player, this.looks)
    avatar.setSpeaking(this.speaking.has(player.id))
    const { id } = player
    if (id !== this.selfId) {
      avatar.onPick(() => {
        if (!this.pickedByPinch()) this.hooks.picked?.(id)
      })
    }
    this.avatars.set(id, avatar)
  }

  // Repeated names get the same suffix here as in the chat.
  private relabel(): void {
    this.labels = new Names(this.names)
    this.avatars.forEach((avatar, id) => avatar.setLabel(this.labels.label(id, this.names.get(id) ?? '')))
  }

  // The floor already marks each room: our room gets a thin yellow outline,
  // and every room a sign in its kind's color on the wall above it.
  private drawZones(zones: ZoneMap): void {
    this.zoneViews = zones.zones.map((zone) => {
      const { x0, y0, x1, y1 } = zone.tiles
      const [x, y, w, h] = [x0 * TILE_SIZE, y0 * TILE_SIZE, (x1 - x0) * TILE_SIZE, (y1 - y0) * TILE_SIZE]
      const color = ZONE_COLORS[zone.kind]
      const outline = this.add.graphics().setDepth(4).lineStyle(2, ACCENT, 0.85).strokeRoundedRect(x + 2, y + 2, w - 4, h - 4, 8)
      const [sign, label] = this.zoneSign(zone.name, color)
      sign.setPosition(x + 6, Math.max(SIGN_HEIGHT / 2, y - TILE_SIZE / 2))
      return { zone, outline, sign, label }
    })
    this.highlightZone()
  }

  private zoneSign(name: string, color: number): [Phaser.GameObjects.Container, Phaser.GameObjects.Text] {
    const text = this.add
      .text(16, 0, name, {
        fontFamily: '"Montserrat", system-ui, sans-serif',
        fontSize: '10px',
        fontStyle: '700',
        color: '#ffffff',
        resolution: this.textResolution(),
      })
      .setOrigin(0, 0.5)
    text.texture.setFilter(Phaser.Textures.FilterMode.LINEAR)
    const width = Math.ceil(text.width) + 22
    const plate = this.add
      .graphics()
      .fillStyle(color, 0.92)
      .fillRoundedRect(0, -SIGN_HEIGHT / 2, width, SIGN_HEIGHT, 4)
      .fillStyle(ACCENT, 1)
      .fillCircle(9, 0, 3)
    return [this.add.container(0, 0, [plate, text]).setDepth(4), text]
  }

  private highlightZone(): void {
    for (const { zone, outline, sign } of this.zoneViews) {
      const here = zone.id === this.zoneId
      outline.setVisible(here)
      sign.setAlpha(here ? 1 : 0.8)
    }
  }

  private showSpeaking(ids: ReadonlySet<string>): void {
    this.speaking = ids
    this.avatars.forEach((avatar, id) => avatar.setSpeaking(ids.has(id)))
  }

  private self(): Avatar | undefined {
    return this.selfId ? this.avatars.get(this.selfId) : undefined
  }

  private createKeys(): DirKeys {
    const keyboard = this.input.keyboard
    if (!keyboard) throw new Error('keyboard input unavailable')
    const { UP, DOWN, LEFT, RIGHT, W, A, S, D } = Phaser.Input.Keyboard.KeyCodes
    const add = (...codes: number[]) => codes.map((code) => keyboard.addKey(code))
    return { up: add(UP, W), down: add(DOWN, S), left: add(LEFT, A), right: add(RIGHT, D) }
  }

  // Looks are composed from the parts atlas into a texture of 12 frames each.
  private lookStore(): LookStore {
    return {
      add: (key: string, look: Appearance) => {
        const parts = this.textures.get(AVATAR_PARTS_KEY).getSourceImage()
        if (!(parts instanceof HTMLImageElement || parts instanceof HTMLCanvasElement)) throw new Error('avatar parts not loaded')
        const texture = this.textures.addCanvas(key, composeStrip(parts, look))
        if (!texture) throw new Error(`could not add texture ${key}`)
        for (let i = 0; i < FRAME_COUNT; i++) texture.add(i, 0, i * FRAME_WIDTH, 0, FRAME_WIDTH, FRAME_HEIGHT)
      },
      remove: (key: string) => {
        this.textures.remove(key)
      },
    }
  }

  private applyTyping(): void {
    const keyboard = this.input?.keyboard
    if (!keyboard) return
    const typing = this.typing.typing
    keyboard.enabled = !typing
    if (typing) keyboard.disableGlobalCapture()
    else keyboard.enableGlobalCapture()
    keyboard.resetKeys()
  }

  private heldDir(): Dir | null {
    const dirs: Dir[] = ['up', 'down', 'left', 'right']
    return dirs.find((dir) => this.keys[dir].some((key) => key.isDown)) ?? null
  }

  private viewSize(): Size {
    return { width: this.scale.width, height: this.scale.height }
  }

  private textResolution(): number {
    return textResolution(this.cameras.main.zoom, window.devicePixelRatio)
  }

  private pickedByPinch(): boolean {
    return this.zoom.pinching || this.time.now - this.pinchEndedAt < PICK_AFTER_PINCH_MS
  }

  // A user's pick is remembered; only the view's default follows resizes.
  private zoomBy(change: () => boolean): void {
    if (!change()) return
    this.zoomPrefs.save(this.zoom.chosen)
    this.applyZoom(true)
  }

  private resized(): void {
    if (this.zoom.resize(this.viewSize())) return this.applyZoom(false)
    this.showZoom()
    this.fitBounds()
  }

  private showZoom(): void {
    const { min, max } = this.zoom.range
    this.hooks.zoom?.show({ level: this.zoom.level, min, max, manual: this.zoom.chosen !== null })
  }

  // The zoom glides between levels and always lands on a whole one, where
  // the pixel art stays crisp; the texts are redrawn for it once there.
  private applyZoom(animate: boolean): void {
    this.showZoom()
    const level = this.zoom.level
    const camera = this.cameras.main
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (!animate || reduced) {
      camera.zoomEffect.reset()
      camera.setZoom(level)
      this.zoomed()
      return
    }
    camera.zoomTo(level, ZOOM_MS, 'Quad.easeOut', true, (_: Phaser.Cameras.Scene2D.Camera, progress: number) => {
      if (progress < 1) this.fitBounds()
      else this.zoomed()
    })
  }

  private zoomed(): void {
    this.fitBounds()
    const resolution = this.textResolution()
    this.avatars.forEach((avatar) => avatar.refreshLabel())
    for (const { label } of this.zoneViews) {
      label.setResolution(resolution)
      label.texture.setFilter(Phaser.Textures.FilterMode.LINEAR)
    }
  }

  private fitBounds(): void {
    const camera = this.cameras.main
    const { x, y, width, height } = cameraBounds(this.viewSize(), this.mapSize, camera.zoom)
    camera.setBounds(x, y, width, height)
  }
}
