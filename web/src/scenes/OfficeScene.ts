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
import { deskGate } from '../game/desks'
import type { Desks } from '../game/desks'
import { Grid } from '../game/grid'
import { Predictor, correctionFor } from '../game/prediction'
import { ZoneMap } from '../game/zones'
import { cameraBounds, followCenter, keepOnScreen, OVERVIEW, overviewCenter, textResolution, Zoom, zoomPrefs } from '../game/zoom'
import type { Point, Rect, Size } from '../game/zoom'
import type { MapZone, TileRect } from '../game/zones'
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
  /** A panel over the map, which the overview keeps clear of. */
  cover?: CoverSource
  /** The desks, already updated when the scene reads a desk message. */
  desks?: Pick<Desks, 'all' | 'get' | 'lockedForMe'>
}

export type CoverSource = {
  /** The part of the screen it covers, or null while closed. */
  rect(): Rect | null
  onChange(fn: () => void): () => void
}

const ZONE_COLORS: Record<Exclude<MapZone['kind'], 'desk'>, number> = { meeting: 0x014c8b, private: 0x7a3fb0 }
// Yellow reads on every room's floor: blue and slate carpets, rubber.
const ACCENT = 0xfdc339
const SIGN_HEIGHT = 16
const SIGN_INSET = 6
const SIGN_MIN_SCREEN = 0.8
// "Ver no mapa": how long the mark stays, and how fast it pulses.
const SPOTLIGHT_MS = 4000
const SPOTLIGHT_FADE_MS = 400
const SPOTLIGHT_PULSE_MS = 1000
const SPOTLIGHT_DEPTH = 5000
const NAVY = 0x00263e
// Desk signs: a pill on the desk row, as wide as the station at most, with a
// lock when the desk is closed to us, whose floor gets a veil.
const DESK_SIGN = 0x0e3a58
const DESK_SIGN_HEIGHT = 13
const DESK_SIGN_PAD = 5
const DESK_SIGN_MARGIN = 3
const LOCK_WIDTH = 7
const LOCK_GAP = 3
const { LINEAR, NEAREST } = Phaser.Textures.FilterMode

type Spotlight = { draw(g: Phaser.GameObjects.Graphics, zoom: number, pulse: number): void; from: number }

type DeskSign = {
  zone: MapZone
  area: Phaser.Geom.Rectangle
  sign: Phaser.GameObjects.Container
  plate: Phaser.GameObjects.Graphics
  lock: Phaser.GameObjects.Graphics
  label: Phaser.GameObjects.Text
  veil: Phaser.GameObjects.Graphics
  text: string
  locked: boolean
}

type ZoneView = {
  zone: MapZone
  area: Phaser.Geom.Rectangle
  outline: Phaser.GameObjects.Graphics
  // Desks have no sign.
  sign: Phaser.GameObjects.Container | null
  label: Phaser.GameObjects.Text | null
}

export class OfficeScene extends Phaser.Scene implements TypingGate {
  private grid!: Grid
  private keys!: DirKeys
  private readonly avatars = new Map<string, Avatar>()
  private readonly names = new Map<string, string>()
  private labels = new Names([])
  private zoneViews: ZoneView[] = []
  private deskSigns: DeskSign[] = []
  private zoneMap = ZoneMap.empty()
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
  private markerZoom = 0
  private signsInside = false
  private smoothTiles = false
  private following = false
  private spotlight: Spotlight | null = null
  private spotlightGraphics!: Phaser.GameObjects.Graphics

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
    const cover = this.hooks.cover
    if (cover) this.zoom.cover(cover.rect())
    const offCover = cover?.onChange(() => this.covered(cover.rect()))
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

    this.spotlightGraphics = this.add.graphics().setDepth(SPOTLIGHT_DEPTH)
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
      offCover?.()
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

  /** Goes to the overview and marks someone for a few seconds. */
  showPerson(id: string): void {
    const avatar = this.avatars.get(id)
    if (!avatar) return
    this.toOverview()
    this.spot((g, zoom, pulse) => {
      const art = keepOnScreen(2, zoom)
      const x = avatar.x
      const y = avatar.y + TILE_SIZE / 2 - (FRAME_HEIGHT * art) / 2
      const r = (FRAME_HEIGHT * art) / 2 + 10 / zoom
      g.lineStyle(6 / zoom, NAVY, 0.6).strokeCircle(x, y, r)
      g.lineStyle(3 / zoom, ACCENT, 1).strokeCircle(x, y, r)
      if (pulse >= 0) g.lineStyle(3 / zoom, ACCENT, 1 - pulse).strokeCircle(x, y, r * (1 + 0.7 * pulse))
    })
  }

  /** Goes to the overview and marks a room or area for a few seconds. */
  showPlace(tiles: TileRect): void {
    this.toOverview()
    const x = tiles.x0 * TILE_SIZE
    const y = tiles.y0 * TILE_SIZE
    const w = (tiles.x1 - tiles.x0) * TILE_SIZE
    const h = (tiles.y1 - tiles.y0) * TILE_SIZE
    this.spot((g, zoom, pulse) => {
      const glow = pulse >= 0 ? 0.14 + 0.16 * Math.sin(pulse * Math.PI) : 0.22
      g.fillStyle(ACCENT, glow).fillRect(x, y, w, h)
      g.lineStyle(6 / zoom, NAVY, 0.5).strokeRoundedRect(x, y, w, h, 8 / zoom)
      g.lineStyle(3 / zoom, ACCENT, 1).strokeRoundedRect(x, y, w, h, 8 / zoom)
    })
  }

  /** Forgets the picked level, as the 0 key does. */
  resetZoom(): void {
    this.zoomBy(() => this.zoom.reset())
  }

  update(time: number): void {
    this.drawSpotlight()
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
      case 'desks':
      case 'deskInvite':
        return this.refreshDesks()
      case 'pong':
        return this.hud.setLatency(performance.now() - msg.d.ts)
      case 'appearance':
        return this.avatars.get(msg.d.id)?.setAppearance(msg.d.appearance)
    }
  }

  // The overview a mark is shown in is not a pick: the saved level stays.
  private toOverview(): void {
    if (this.zoom.set(OVERVIEW)) this.applyZoom(true)
  }

  private spot(draw: Spotlight['draw']): void {
    this.spotlight = { draw, from: this.time.now }
  }

  private drawSpotlight(): void {
    const g = this.spotlightGraphics
    g.clear()
    const spot = this.spotlight
    if (!spot) return
    const age = this.time.now - spot.from
    if (age > SPOTLIGHT_MS) {
      this.spotlight = null
      return
    }
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    g.setAlpha(reduced ? 1 : Math.min(1, (SPOTLIGHT_MS - age) / SPOTLIGHT_FADE_MS))
    spot.draw(g, this.cameras.main.zoom, reduced ? -1 : (age % SPOTLIGHT_PULSE_MS) / SPOTLIGHT_PULSE_MS)
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
    this.refreshDesks()
    this.following = false
    this.placeCamera()
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
  // and every room but the desks a sign in its kind's color on the wall
  // above it. Desks get theirs on the desk itself.
  private drawZones(zones: ZoneMap): void {
    this.zoneMap = zones
    this.zoneViews = zones.zones.map((zone) => {
      const { x0, y0, x1, y1 } = zone.tiles
      const area = new Phaser.Geom.Rectangle(x0 * TILE_SIZE, y0 * TILE_SIZE, (x1 - x0) * TILE_SIZE, (y1 - y0) * TILE_SIZE)
      const outline = this.add.graphics().setDepth(4)
      if (zone.kind === 'desk') {
        this.deskSigns.push(this.deskSign(zone, area))
        return { zone, area, outline, sign: null, label: null }
      }
      const [sign, label] = this.zoneSign(zone.name, ZONE_COLORS[zone.kind])
      return { zone, area, outline, sign, label }
    })
    this.highlightZone()
  }

  // On the row of the station that is all desk, else the middle one.
  private deskSign(zone: MapZone, area: Phaser.Geom.Rectangle): DeskSign {
    const { x0, y0, x1, y1 } = zone.tiles
    const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i)
    const row = range(y0, y1).find((y) => range(x0, x1).every((x) => this.grid.isBlocked(x, y))) ?? y0 + Math.floor((y1 - y0) / 2)
    const veil = this.add.graphics().setDepth(3.5).fillStyle(NAVY, 0.1).fillRect(area.x, area.y, area.width, area.height).setVisible(false)
    const plate = this.add.graphics()
    const lock = this.add.graphics()
    const label = this.add
      .text(0, 0, '', {
        fontFamily: '"Montserrat", system-ui, sans-serif',
        fontSize: '9px',
        fontStyle: '700',
        color: '#ffffff',
        resolution: this.textResolution(),
      })
      .setOrigin(0, 0.5)
    label.texture.setFilter(LINEAR)
    const sign = this.add.container(area.centerX, row * TILE_SIZE + TILE_SIZE / 2, [plate, lock, label]).setDepth(4)
    return { zone, area, sign, plate, lock, label, veil, text: zone.name, locked: false }
  }

  // The owner's name, or the desk's own for one without an owner; the gate
  // the prediction walks by mirrors who the server lets in.
  private refreshDesks(): void {
    const desks = this.hooks.desks
    if (!desks) return
    const locked = new Set(desks.all().flatMap((d) => (desks.lockedForMe(d.id) ? [d.id] : [])))
    this.predictor?.setGate(deskGate(this.zoneMap, (id) => locked.has(id)))
    for (const sign of this.deskSigns) {
      const desk = desks.get(sign.zone.id)
      sign.text = desk?.locked && desk.ownerName ? desk.ownerName : sign.zone.name
      sign.locked = locked.has(sign.zone.id)
      sign.veil.setVisible(sign.locked)
      this.layoutDeskSign(sign)
    }
  }

  // Sized like the room signs, at least 1× on screen; the name is cut to the
  // station's width at the current zoom.
  private layoutDeskSign(sign: DeskSign): void {
    const scale = keepOnScreen(1, this.cameras.main.zoom)
    const lockWidth = sign.locked ? LOCK_WIDTH + LOCK_GAP : 0
    fitText(sign.label, sign.text, (sign.area.width - 2 * DESK_SIGN_MARGIN) / scale - 2 * DESK_SIGN_PAD - lockWidth)
    const width = Math.ceil(sign.label.width) + 2 * DESK_SIGN_PAD + lockWidth
    const left = -width / 2
    sign.plate
      .clear()
      .fillStyle(DESK_SIGN, 0.9)
      .fillRoundedRect(left, -DESK_SIGN_HEIGHT / 2, width, DESK_SIGN_HEIGHT, 4)
    sign.lock.clear().setVisible(sign.locked)
    if (sign.locked) {
      const x = left + DESK_SIGN_PAD
      sign.lock
        .lineStyle(1.4, ACCENT, 1)
        .beginPath()
        .arc(x + LOCK_WIDTH / 2, -1, 2.2, Math.PI, 0)
        .strokePath()
        .fillStyle(ACCENT, 1)
        .fillRoundedRect(x, -1, LOCK_WIDTH, 5, 1)
    }
    sign.label.setX(left + DESK_SIGN_PAD + lockWidth)
    sign.sign.setScale(scale).setSize(width, DESK_SIGN_HEIGHT)
  }

  // Below 1× the outline keeps its 1× size on screen and so do the signs.
  // Once a sign no longer fits the wall above its room it moves into the
  // room's bottom corner, opaque, out of the way of the names over people's
  // heads, and shrinks to SIGN_MIN_SCREEN of its size where the room is too
  // narrow for it, never past the map's edge.
  private scaleZones(zoom: number): void {
    const scale = keepOnScreen(1, zoom)
    this.signsInside = SIGN_HEIGHT * scale > TILE_SIZE
    for (const { zone, area, outline, sign } of this.zoneViews) {
      const inset = 2 * scale
      const desk = zone.kind === 'desk'
      outline
        .clear()
        .lineStyle((desk ? 1.5 : 2) * scale, ACCENT, desk ? 0.6 : 0.85)
        .strokeRoundedRect(area.x + inset, area.y + inset, area.width - 2 * inset, area.height - 2 * inset, (desk ? 6 : 8) * scale)
      if (!sign) continue
      if (!this.signsInside) {
        sign.setScale(scale).setPosition(area.x + SIGN_INSET, Math.max((SIGN_HEIGHT * scale) / 2, area.y - TILE_SIZE / 2))
        continue
      }
      const margin = SIGN_INSET * scale
      const fits = (area.width - 2 * margin) / sign.width
      const signScale = Math.max(keepOnScreen(1, zoom, SIGN_MIN_SCREEN), Math.min(scale, fits))
      const x = Math.min(area.x + margin, this.mapSize.width - margin - sign.width * signScale)
      sign.setScale(signScale).setPosition(x, area.bottom - margin - (SIGN_HEIGHT * signScale) / 2)
    }
    for (const sign of this.deskSigns) this.layoutDeskSign(sign)
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
    return [this.add.container(0, 0, [plate, text]).setSize(width, SIGN_HEIGHT).setDepth(4), text]
  }

  private highlightZone(): void {
    for (const { zone, outline, sign } of this.zoneViews) {
      const here = zone.id === this.zoneId
      outline.setVisible(here)
      sign?.setAlpha(here || this.signsInside ? 1 : 0.8)
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
    const { zoom } = this.cameras.main
    return textResolution(zoom * keepOnScreen(1, zoom), window.devicePixelRatio)
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

  // A panel anchored to a corner moves with the window.
  private resized(): void {
    const before = this.zoom.level
    this.zoom.cover(this.hooks.cover?.rect() ?? null)
    this.zoom.resize(this.viewSize())
    if (this.zoom.level !== before) return this.applyZoom(false)
    this.showZoom()
    this.placeCamera()
  }

  // In the overview the map moves out from under a panel opened over it;
  // the whole levels do not depend on it.
  private covered(rect: Rect | null): void {
    this.zoom.cover(rect)
    if (this.zoom.overview) this.applyZoom(true)
  }

  private showZoom(): void {
    const { level, overview, canZoomIn, canZoomOut, chosen } = this.zoom
    this.hooks.zoom?.show({ level, overview, canIn: canZoomIn, canOut: canZoomOut, manual: chosen !== null })
  }

  // The zoom glides between levels and lands on a whole one, where the pixel
  // art stays crisp, or on the overview, which fits the whole office in the
  // free part of the screen and leaves the avatar to walk on its own. Into
  // and out of the overview the camera pans too, to the office's middle or
  // back to where following the avatar puts it. The texts are redrawn for
  // the level once there.
  private applyZoom(animate: boolean): void {
    this.showZoom()
    const level = this.zoom.level
    const camera = this.cameras.main
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (!animate || reduced) {
      camera.zoomEffect.reset()
      camera.panEffect.reset()
      camera.setZoom(level)
      this.placeCamera()
      this.zoomed()
      return
    }
    const target = this.zoom.overview ? this.overviewCenter(level) : this.following ? null : this.followCenter(level)
    if (target) {
      this.unfollow()
      camera.pan(target.x, target.y, ZOOM_MS, 'Quad.easeOut', true)
    }
    camera.zoomTo(level, ZOOM_MS, 'Quad.easeOut', true, (_: Phaser.Cameras.Scene2D.Camera, progress: number) => {
      if (progress < 1) return this.rescale()
      this.placeCamera()
      this.zoomed()
    })
  }

  private zoomed(): void {
    this.rescale()
    const resolution = this.textResolution()
    this.avatars.forEach((avatar) => avatar.refreshLabel())
    for (const { label } of [...this.zoneViews, ...this.deskSigns]) {
      label?.setResolution(resolution)
      label?.texture.setFilter(LINEAR)
    }
  }

  // Follows the camera's zoom on every frame of a change. Below 1× the
  // office's art is scaled down smoothly instead of dropping pixels, and
  // what marks people and rooms keeps its size on screen.
  private rescale(): void {
    if (this.following) this.fitBounds()
    const { zoom } = this.cameras.main
    this.avatars.forEach((avatar) => avatar.scaleTo(zoom))
    const smooth = zoom < 1
    if (smooth !== this.smoothTiles) {
      this.smoothTiles = smooth
      this.textures.get(TILES_KEY).setFilter(smooth ? LINEAR : NEAREST)
    }
    if (zoom !== this.markerZoom) {
      this.markerZoom = zoom
      this.scaleZones(zoom)
    }
  }

  // The overview holds the office still in the free area; every other
  // level follows the avatar within the map.
  private placeCamera(): void {
    const camera = this.cameras.main
    if (this.zoom.overview) {
      this.unfollow()
      const { x, y } = this.overviewCenter(camera.zoom)
      camera.centerOn(x, y)
      return
    }
    this.fitBounds()
    const avatar = this.self()
    if (!avatar || this.following) return
    camera.startFollow(avatar, true)
    this.following = true
  }

  private unfollow(): void {
    const camera = this.cameras.main
    camera.stopFollow()
    camera.removeBounds()
    this.following = false
  }

  private overviewCenter(zoom: number): Point {
    return overviewCenter(this.viewSize(), this.mapSize, zoom, this.zoom.free)
  }

  private followCenter(zoom: number): Point {
    const avatar = this.self()
    const target = avatar ? { x: avatar.x, y: avatar.y } : { x: this.mapSize.width / 2, y: this.mapSize.height / 2 }
    return followCenter(this.viewSize(), this.mapSize, zoom, target)
  }

  private fitBounds(): void {
    const camera = this.cameras.main
    const { x, y, width, height } = cameraBounds(this.viewSize(), this.mapSize, camera.zoom)
    camera.setBounds(x, y, width, height)
  }
}

// Cuts text with "…" until it fits width; the empty string when nothing does.
function fitText(label: Phaser.GameObjects.Text, text: string, width: number): void {
  label.setText(text)
  for (let n = text.length - 1; label.width > width && n >= 0; n--) label.setText(n === 0 ? '' : `${text.slice(0, n).trimEnd()}…`)
}
