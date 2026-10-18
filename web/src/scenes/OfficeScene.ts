import Phaser from 'phaser'
import { Avatar } from '../entities/Avatar'
import { Grid } from '../game/grid'
import { Predictor, correctionFor } from '../game/prediction'
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

export class OfficeScene extends Phaser.Scene {
  private grid!: Grid
  private keys!: DirKeys
  private readonly avatars = new Map<string, Avatar>()
  private selfId: string | null = null
  private predictor: Predictor | null = null
  private stepMs = DEFAULT_STEP_MS
  private nextStepAt = 0
  private speaking: ReadonlySet<string> = new Set()

  constructor(
    private readonly connection: Connection,
    private readonly hud: Hud,
    private readonly speakers?: SpeakingSource,
  ) {
    super('office')
  }

  create(): void {
    const map = this.make.tilemap({ key: MAP_KEY })
    const tileset = map.addTilesetImage(TILESET_NAME, TILES_KEY)
    if (!tileset) throw new Error(`tileset "${TILESET_NAME}" missing from map`)
    map.createLayer('floor', tileset)
    map.createLayer('walls', tileset)

    const cached: { data: unknown } = this.cache.tilemap.get(MAP_KEY)
    this.grid = Grid.fromTiled(cached.data)

    this.cameras.main.setBounds(0, 0, map.widthInPixels, map.heightInPixels)
    this.fitCamera()
    this.scale.on(Phaser.Scale.Events.RESIZE, this.fitCamera, this)

    this.keys = this.createKeys()

    const offMessage = this.connection.onMessage((msg) => this.handle(msg))
    const offStatus = this.connection.onStatus((status) => {
      if (status !== 'open') this.predictor = null
    })
    const offSpeaking = this.speakers?.onSpeaking((ids) => this.showSpeaking(ids))
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

  update(time: number): void {
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
        return this.upsert(msg.d)
      case 'left':
        this.avatars.get(msg.d.id)?.destroy()
        this.avatars.delete(msg.d.id)
        return
      case 'state':
        return this.onState(msg.d)
      case 'pong':
        return this.hud.setLatency(performance.now() - msg.d.ts)
    }
  }

  private onWelcome(welcome: Welcome): void {
    this.avatars.forEach((avatar) => avatar.destroy())
    this.avatars.clear()
    this.stepMs = welcome.stepMs
    this.selfId = welcome.selfId
    welcome.players.forEach((player) => this.upsert(player))

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
    const existing = this.avatars.get(player.id)
    if (existing) {
      existing.snapTo(player)
      existing.setLabel(player.name)
      return
    }
    const avatar = new Avatar(this, player)
    avatar.setSpeaking(this.speaking.has(player.id))
    this.avatars.set(player.id, avatar)
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
