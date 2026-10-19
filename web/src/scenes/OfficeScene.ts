import Phaser from 'phaser'
import type { TypingGate } from '../chat/keys'
import { Names } from '../chat/names'
import { Avatar } from '../entities/Avatar'
import { Grid } from '../game/grid'
import { Predictor, correctionFor } from '../game/prediction'
import { ZoneMap } from '../game/zones'
import type { MapZone } from '../game/zones'
import type { Connection } from '../net/connection'
import type { Dir, Player, Pos, ServerMessage, State, Welcome } from '../net/protocol'
import type { Hud } from '../ui/hud'
import { MAP_KEY, TILE_SIZE, TILES_KEY, TILESET_NAME } from './assets'

const PING_INTERVAL_MS = 2000
const DEFAULT_STEP_MS = 150

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
}

const ZONE_COLORS: Record<MapZone['kind'], number> = { meeting: 0x5b8dd6, private: 0x9b6bc8 }
const SIGN_COLOR = 0x2b2420
const SIGN_HEIGHT = 16

type ZoneView = { zone: MapZone; outline: Phaser.GameObjects.Graphics; sign: Phaser.GameObjects.Container }

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
  private typing = false

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

    this.cameras.main.setBounds(0, 0, map.widthInPixels, map.heightInPixels)
    this.fitCamera()
    this.scale.on(Phaser.Scale.Events.RESIZE, this.fitCamera, this)

    this.keys = this.createKeys()
    this.applyTyping()

    const offMessage = this.connection.onMessage((msg) => this.handle(msg))
    const offStatus = this.connection.onStatus((status) => {
      if (status !== 'open') this.predictor = null
    })
    const offSpeaking = this.hooks.speakers?.onSpeaking((ids) => this.showSpeaking(ids))
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      offMessage()
      offStatus()
      offSpeaking?.()
      this.scale.off(Phaser.Scale.Events.RESIZE, this.fitCamera, this)
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
  setTyping(on: boolean): void {
    if (this.typing === on) return
    this.typing = on
    this.applyTyping()
  }

  update(time: number): void {
    if (this.typing) return
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
      return
    }
    const avatar = new Avatar(this, player)
    avatar.setSpeaking(this.speaking.has(player.id))
    const { id } = player
    if (id !== this.selfId) avatar.onPick(() => this.hooks.picked?.(id))
    this.avatars.set(id, avatar)
  }

  // Repeated names get the same suffix here as in the chat.
  private relabel(): void {
    this.labels = new Names(this.names)
    this.avatars.forEach((avatar, id) => avatar.setLabel(this.labels.label(id, this.names.get(id) ?? '')))
  }

  // The carpet already marks each room: our room gets a thin outline, and
  // every room a sign with its name on the wall above it.
  private drawZones(zones: ZoneMap): void {
    this.zoneViews = zones.zones.map((zone) => {
      const { x0, y0, x1, y1 } = zone.tiles
      const [x, y, w, h] = [x0 * TILE_SIZE, y0 * TILE_SIZE, (x1 - x0) * TILE_SIZE, (y1 - y0) * TILE_SIZE]
      const color = ZONE_COLORS[zone.kind]
      const outline = this.add.graphics().setDepth(4).lineStyle(2, color, 0.4).strokeRoundedRect(x + 2, y + 2, w - 4, h - 4, 8)
      const sign = this.zoneSign(zone.name, color).setPosition(x + 6, Math.max(SIGN_HEIGHT / 2, y - TILE_SIZE / 2))
      return { zone, outline, sign }
    })
    this.highlightZone()
  }

  private zoneSign(name: string, color: number): Phaser.GameObjects.Container {
    const text = this.add
      .text(16, 0, name, {
        fontFamily: '"Nunito", system-ui, sans-serif',
        fontSize: '10px',
        fontStyle: '700',
        color: '#ffffff',
        resolution: 4,
      })
      .setOrigin(0, 0.5)
    text.texture.setFilter(Phaser.Textures.FilterMode.LINEAR)
    const width = Math.ceil(text.width) + 22
    const plate = this.add
      .graphics()
      .fillStyle(SIGN_COLOR, 0.78)
      .fillRoundedRect(0, -SIGN_HEIGHT / 2, width, SIGN_HEIGHT, SIGN_HEIGHT / 2)
      .fillStyle(color, 1)
      .fillCircle(9, 0, 3)
    return this.add.container(0, 0, [plate, text]).setDepth(4)
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

  private applyTyping(): void {
    const keyboard = this.input?.keyboard
    if (!keyboard) return
    keyboard.enabled = !this.typing
    if (this.typing) keyboard.disableGlobalCapture()
    else keyboard.enableGlobalCapture()
    keyboard.resetKeys()
  }

  private heldDir(): Dir | null {
    const dirs: Dir[] = ['up', 'down', 'left', 'right']
    return dirs.find((dir) => this.keys[dir].some((key) => key.isDown)) ?? null
  }

  private fitCamera(): void {
    const { width, height } = this.scale
    const zoom = Math.max(1, Math.min(3, Math.floor(Math.min(width / (15 * TILE_SIZE), height / (10 * TILE_SIZE)))))
    this.cameras.main.setZoom(zoom)
  }
}
