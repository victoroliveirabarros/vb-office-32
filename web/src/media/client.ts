import { Names } from '../chat/names'
import type { Tile } from '../game/grid'
import { backoffDelay } from '../net/connection'
import type { ConnectionStatus } from '../net/connection'
import type { Media, ServerMessage, Zone } from '../net/protocol'
import { AllowedSubscribers } from './permissions'
import type { MediaPrefs } from './prefs'
import { distance, nearest, VIDEO_LIMIT, volumeAt } from './proximity'
import { disconnectAction } from './reconnect'
import type { DisconnectKind } from './reconnect'
import { canShare, inMeeting, screenTarget, sharers, shouldStop } from './screen'
import { subscriptionChanges, videoCandidates } from './subscriptions'
import type { Publication, TrackSource } from './subscriptions'

export type DeviceError = 'denied' | 'not-found' | 'in-use' | 'other'

export class DeviceFailure extends Error {
  constructor(readonly kind: DeviceError) {
    super(`media device failure: ${kind}`)
  }
}

export type RemoteMedia = {
  identity: string
  source: TrackSource
  attach(): HTMLMediaElement
}

export type RoomListener = {
  changed(): void
  reconnecting(): void
  reconnected(): void
  disconnected(kind: DisconnectKind): void
  subscribed(media: RemoteMedia): void
  unsubscribed(identity: string, source: TrackSource): void
  speakers(ids: string[]): void
  playback(allowed: boolean): void
  // The local screen share ended, from the browser's own stop button too.
  screenEnded(): void
}

// MediaRoom is the slice of a LiveKit Room the client drives; livekit.ts
// implements it so that nothing here loads the SDK.
export interface MediaRoom {
  readonly canPlaybackAudio: boolean
  connect(url: string, token: string): Promise<void>
  disconnect(): Promise<void>
  participants(): string[]
  publications(): Publication[]
  setSubscribed(identity: string, sid: string, subscribed: boolean): void
  // Only these identities may receive our tracks; LiveKit enforces it.
  setAllowedSubscribers(ids: readonly string[]): void
  setVolume(identity: string, volume: number): void
  setMicrophoneEnabled(on: boolean): Promise<void>
  // Returns the local preview while the camera is on.
  setCameraEnabled(on: boolean): Promise<HTMLMediaElement | null>
  // Resolves whether the screen is shared now: false when the picker was
  // cancelled.
  setScreenShareEnabled(on: boolean): Promise<boolean>
  startAudio(): Promise<void>
}

export type RoomFactory = (listener: RoomListener) => Promise<MediaRoom>

export type LinkState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'retrying' | 'waiting' | 'stopped'

export type DeviceState = { on: boolean; busy: boolean; error: DeviceError | null }

// meeting: we are in a meeting room; taken: someone else there shares.
export type ScreenState = DeviceState & { meeting: boolean; taken: boolean }

export interface MediaView {
  setLink(state: LinkState): void
  setMic(state: DeviceState): void
  setCamera(state: DeviceState): void
  setScreen(state: ScreenState): void
  setPlaybackBlocked(blocked: boolean): void
  addAudio(el: HTMLMediaElement): void
  showVideo(identity: string, name: string, el: HTMLMediaElement): void
  hideVideo(identity: string): void
  showSelfVideo(el: HTMLMediaElement | null): void
  showScreen(identity: string, name: string, el: HTMLMediaElement): void
  hideScreen(identity: string): void
  clear(): void
}

export type MediaControls = {
  toggleMic(): void
  toggleCamera(): void
  toggleScreen(): void
  startAudio(): void
}

export type SpeakingListener = (ids: ReadonlySet<string>) => void

export type MediaClientOptions = {
  createRoom: RoomFactory
  view: MediaView
  prefs: MediaPrefs
  now?: () => number
}

type Placed = Tile & { name: string }

export class MediaClient implements MediaControls {
  private room: MediaRoom | null = null
  private grant: Media | null = null
  private grantAt = -Infinity
  private link: LinkState = 'idle'
  private attempt = 0
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private selfId: string | null = null
  private readonly players = new Map<string, Placed>()
  private nearby: ReadonlySet<string> = new Set()
  // Who may receive our tracks: nearby while the game socket is up, nobody
  // from a welcome until the next nearby.
  private permitted: ReadonlySet<string> = new Set()
  private readonly allowed = new AllowedSubscribers()
  private zone: Zone | null = null
  private readonly volumes = new Map<string, number>()
  private speakers: readonly string[] = []
  private speaking: ReadonlySet<string> = new Set()
  private readonly speakingListeners = new Set<SpeakingListener>()
  private mic: DeviceState
  private camera: DeviceState = { on: false, busy: false, error: null }
  private screen: DeviceState = { on: false, busy: false, error: null }
  private screenTaken = false
  // What the room carries; null when a failed call left it unknown.
  private micLive: boolean | null = false
  private cameraLive: boolean | null = false
  private screenLive: boolean | null = false
  // Bumped whenever the room is dropped, so late results are ignored.
  private session = 0
  private readonly createRoom: RoomFactory
  private readonly view: MediaView
  private readonly prefs: MediaPrefs
  private readonly now: () => number

  constructor(options: MediaClientOptions) {
    this.createRoom = options.createRoom
    this.view = options.view
    this.prefs = options.prefs
    this.now = options.now ?? Date.now
    this.mic = { on: !this.prefs.micMuted(), busy: false, error: null }
  }

  get state(): LinkState {
    return this.link
  }

  onSpeaking(fn: SpeakingListener): () => void {
    this.speakingListeners.add(fn)
    fn(this.speaking)
    return () => this.speakingListeners.delete(fn)
  }

  handle(msg: ServerMessage): void {
    switch (msg.t) {
      case 'welcome':
        this.selfId = msg.d.selfId
        this.players.clear()
        for (const p of msg.d.players) this.players.set(p.id, { name: p.name, x: p.x, y: p.y })
        this.permitted = new Set()
        this.applyPermissions()
        return this.sync(false)
      case 'joined':
        this.players.set(msg.d.id, { name: msg.d.name, x: msg.d.x, y: msg.d.y })
        return
      case 'left':
        this.players.delete(msg.d.id)
        return
      case 'state':
        return this.onState(msg.d.players)
      case 'media':
        return this.onMedia(msg.d)
      case 'zone':
        return this.onZone(msg.d)
      case 'nearby':
        this.nearby = new Set(msg.d.ids)
        this.permitted = this.nearby
        this.applyPermissions()
        this.sync(true)
        return this.emitSpeaking()
    }
  }

  // The game socket dropping keeps the room, but nobody may receive us
  // until the server places us again; the next nearby reconciles it.
  setConnectionStatus(status: ConnectionStatus): void {
    if (status !== 'open') {
      this.permitted = new Set()
      this.applyPermissions()
    }
    if (status === 'replaced' || status === 'expired') this.stop()
  }

  stop(): void {
    if (this.link === 'stopped') return
    if (this.link === 'idle') {
      this.link = 'stopped'
      return
    }
    this.setLink('stopped')
    this.session++
    clearTimeout(this.retryTimer)
    this.resetMedia()
    void this.room?.disconnect()
  }

  toggleMic(): void {
    if (this.mic.busy) return
    const on = !this.mic.on
    this.prefs.setMicMuted(!on)
    this.setMic({ on, busy: false, error: null })
    void this.applyMic()
  }

  toggleCamera(): void {
    if (this.camera.busy) return
    this.setCamera({ on: !this.camera.on, busy: false, error: null })
    void this.applyCamera()
  }

  // Must run inside the click handler: the screen picker needs a gesture.
  toggleScreen(): void {
    if (this.screen.busy) return
    const on = !this.screen.on
    if (on && !canShare(this.zone, this.link === 'connected', this.screenTaken)) return
    this.setScreen({ on, busy: false, error: null })
    void this.applyScreen()
  }

  // Must run inside the click handler: browsers unlock audio on a gesture.
  startAudio(): void {
    const room = this.room
    if (!room) return
    void room.startAudio().then(
      () => this.view.setPlaybackBlocked(!room.canPlaybackAudio),
      () => this.view.setPlaybackBlocked(true),
    )
  }

  private onState(moved: readonly { id: string; x: number; y: number }[]): void {
    let relevant = false
    for (const pos of moved) {
      const player = this.players.get(pos.id)
      if (player) this.players.set(pos.id, { ...player, x: pos.x, y: pos.y })
      if (pos.id === this.selfId || this.nearby.has(pos.id)) relevant = true
    }
    if (relevant) this.sync(false)
  }

  private onZone(zone: Zone): void {
    this.zone = zone.id === '' ? null : zone
    if (this.screen.on && !this.screen.busy && shouldStop(this.zone)) {
      this.screen = { on: false, busy: false, error: null }
      void this.applyScreen()
    }
    this.renderScreen()
    this.sync(false)
  }

  private onMedia(grant: Media): void {
    if (this.link === 'stopped') return
    this.grant = grant
    this.grantAt = this.now()
    this.view.setMic(this.mic)
    this.view.setCamera(this.camera)
    this.renderScreen()
    if (this.link === 'idle' || this.link === 'waiting') void this.connect()
  }

  private async connect(): Promise<void> {
    const grant = this.grant
    if (!grant) return
    this.setLink('connecting')
    const session = ++this.session
    this.micLive = false
    this.cameraLive = false
    let room = this.room
    try {
      if (!room) {
        room = await this.createRoom(this.listener)
        if (session !== this.session) {
          void room.disconnect()
          return
        }
        this.room = room
      }
      // Nobody may subscribe until the server says who is near.
      this.sendPermissions([], true)
      await room.connect(grant.url, grant.token)
    } catch {
      if (session === this.session) this.lost('other')
      return
    }
    if (session !== this.session) {
      void room.disconnect()
      return
    }
    this.attempt = 0
    this.sendPermissions(this.permitted, true)
    this.setLink('connected')
    this.view.setPlaybackBlocked(!room.canPlaybackAudio)
    this.sync(true)
    await this.applyDevices()
  }

  private lost(kind: DisconnectKind): void {
    this.session++
    this.resetMedia()
    switch (disconnectAction(kind, this.grant, this.now(), this.grantAt)) {
      case 'stop':
        return this.setLink('stopped')
      case 'wait':
        return this.setLink('waiting')
      case 'retry':
        this.setLink('retrying')
        this.retryTimer = setTimeout(() => this.retry(), backoffDelay(this.attempt++))
    }
  }

  private retry(): void {
    if (this.link !== 'retrying') return
    if (disconnectAction('other', this.grant, this.now()) === 'retry') void this.connect()
    else this.setLink('waiting')
  }

  private readonly listener: RoomListener = {
    changed: () => this.sync(true),
    reconnecting: () => {
      if (this.link === 'connected') this.setLink('reconnecting')
    },
    reconnected: () => {
      if (this.link !== 'reconnecting') return
      this.setLink('connected')
      this.sync(true)
      void this.applyDevices()
    },
    disconnected: (kind) => {
      if (this.link === 'connected' || this.link === 'reconnecting') this.lost(kind)
    },
    subscribed: (media) => {
      const el = media.attach()
      const player = this.players.get(media.identity)
      const name = player ? new Names([...this.players].map(([id, p]) => [id, p.name] as const)).label(media.identity, player.name) : media.identity
      switch (media.source) {
        case 'microphone':
          return this.view.addAudio(el)
        case 'camera':
          return this.view.showVideo(media.identity, name, el)
        case 'screen':
          return this.view.showScreen(media.identity, name, el)
      }
    },
    unsubscribed: (identity, source) => this.hide(identity, source),
    speakers: (ids) => {
      this.speakers = ids
      this.emitSpeaking()
    },
    playback: (allowed) => this.view.setPlaybackBlocked(!allowed),
    screenEnded: () => {
      if (this.screen.busy) return
      this.screenLive = false
      if (this.screen.on) this.setScreen({ on: false, busy: false, error: null })
    },
  }

  private hide(identity: string, source: TrackSource): void {
    if (source === 'camera') this.view.hideVideo(identity)
    else if (source === 'screen') this.view.hideScreen(identity)
  }

  private applyPermissions(): void {
    this.sendPermissions(this.permitted, false)
  }

  private sendPermissions(ids: Iterable<string>, force: boolean): void {
    const room = this.room
    if (!room || this.link === 'stopped') return
    if (force) this.allowed.reset()
    const list = this.allowed.update(ids)
    if (list) room.setAllowedSubscribers(list)
  }

  private sync(full: boolean): void {
    const room = this.room
    if (!room || (this.link !== 'connected' && this.link !== 'reconnecting')) return

    const pubs = room.publications()
    const watched = new Set(pubs.filter((p) => p.source === 'camera' && p.desired).map((p) => p.identity))
    const camera = nearest(videoCandidates(pubs, this.nearby), (id) => this.distanceTo(id), VIDEO_LIMIT, watched)
    const current = pubs.find((p) => p.source === 'screen' && p.desired)?.identity ?? null
    const target = screenTarget(pubs, this.nearby, this.zone, current)
    const screen = new Set(target === null ? [] : [target])
    for (const change of subscriptionChanges(pubs, { microphone: this.nearby, camera, screen })) {
      room.setSubscribed(change.identity, change.sid, change.subscribe)
      if (!change.subscribe) this.hide(change.identity, change.source)
    }
    const taken = sharers(pubs, this.nearby).size > 0
    if (taken !== this.screenTaken) {
      this.screenTaken = taken
      this.renderScreen()
    }

    // Inside a zone nearby is the whole room, which hears itself in full.
    if (full) this.volumes.clear()
    for (const id of full ? room.participants() : this.nearby) {
      const volume = this.nearby.has(id) ? (this.zone ? 1 : volumeAt(this.distanceTo(id))) : 0
      if (this.volumes.get(id) === volume) continue
      this.volumes.set(id, volume)
      room.setVolume(id, volume)
    }
  }

  private distanceTo(id: string): number {
    const self = this.selfId ? this.players.get(this.selfId) : undefined
    const other = this.players.get(id)
    return self && other ? distance(self, other) : Infinity
  }

  private async applyDevices(): Promise<void> {
    await this.applyMic()
    await this.applyCamera()
  }

  // Turning a device off only mutes the local track, so it is safe while
  // LiveKit reconnects; turning one on waits for the connection.
  private canApply(on: boolean): boolean {
    return this.link === 'connected' || (this.link === 'reconnecting' && !on)
  }

  private async applyMic(): Promise<void> {
    const room = this.room
    const on = this.mic.on
    if (!room || this.mic.busy || this.micLive === on || !this.canApply(on)) return
    const session = this.session
    this.setMic({ on, busy: true, error: null })
    const error = await room.setMicrophoneEnabled(on).then(() => null, deviceError)
    if (session === this.session) {
      if (error) {
        this.micLive = on ? false : null
        return this.setMic({ on: false, busy: false, error })
      }
      this.micLive = on
    }
    this.setMic({ on, busy: false, error: null })
    await this.applyMic()
  }

  private async applyCamera(): Promise<void> {
    const room = this.room
    const on = this.camera.on
    if (!room || this.camera.busy || this.cameraLive === on || !this.canApply(on)) return
    const session = this.session
    this.setCamera({ on, busy: true, error: null })
    let preview: HTMLMediaElement | null = null
    let error: DeviceError | null = null
    try {
      preview = await room.setCameraEnabled(on)
    } catch (err) {
      error = deviceError(err)
    }
    if (session === this.session) {
      if (error) {
        this.cameraLive = on ? false : null
        this.view.showSelfVideo(null)
        return this.setCamera({ on: false, busy: false, error })
      }
      this.cameraLive = on
      this.view.showSelfVideo(preview)
    }
    this.setCamera({ on, busy: false, error: null })
    await this.applyCamera()
  }

  // A share never restarts by itself: the picker needs a gesture.
  private async applyScreen(): Promise<void> {
    const room = this.room
    const on = this.screen.on
    if (!room || this.screen.busy || this.screenLive === on || !this.canApply(on)) return
    const session = this.session
    this.setScreen({ on, busy: true, error: null })
    let live = false
    let error: DeviceError | null = null
    try {
      live = await room.setScreenShareEnabled(on)
    } catch (err) {
      error = deviceError(err)
    }
    if (session !== this.session) {
      if (live) void room.setScreenShareEnabled(false).catch(() => {})
      return
    }
    if (error) {
      this.screenLive = on ? false : null
      return this.setScreen({ on: false, busy: false, error })
    }
    this.screenLive = live
    this.setScreen({ on: live && !shouldStop(this.zone), busy: false, error: null })
    await this.applyScreen()
  }

  private renderScreen(): void {
    this.view.setScreen({ ...this.screen, meeting: inMeeting(this.zone), taken: this.screenTaken })
  }

  private resetMedia(): void {
    this.allowed.reset()
    this.screenLive = false
    this.screenTaken = false
    this.setScreen({ on: false, busy: false, error: null })
    this.volumes.clear()
    this.speakers = []
    this.emitSpeaking()
    this.view.setPlaybackBlocked(false)
    this.view.clear()
  }

  private setLink(link: LinkState): void {
    this.link = link
    this.view.setLink(link)
  }

  private setMic(state: DeviceState): void {
    this.mic = state
    this.view.setMic(state)
  }

  private setCamera(state: DeviceState): void {
    this.camera = state
    this.view.setCamera(state)
  }

  private setScreen(state: DeviceState): void {
    this.screen = state
    this.renderScreen()
  }

  private emitSpeaking(): void {
    const ids = new Set(this.speakers.filter((id) => id === this.selfId || this.nearby.has(id)))
    if (ids.size === this.speaking.size && [...ids].every((id) => this.speaking.has(id))) return
    this.speaking = ids
    this.speakingListeners.forEach((fn) => fn(ids))
  }
}

function deviceError(err: unknown): DeviceError {
  return err instanceof DeviceFailure ? err.kind : 'other'
}
