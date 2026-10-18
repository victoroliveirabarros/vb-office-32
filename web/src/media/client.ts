import type { Tile } from '../game/grid'
import { backoffDelay } from '../net/connection'
import type { ConnectionStatus } from '../net/connection'
import type { Media, ServerMessage } from '../net/protocol'
import type { MediaPrefs } from './prefs'
import { distance, nearest, VIDEO_LIMIT, volumeAt } from './proximity'
import { disconnectAction } from './reconnect'
import type { DisconnectKind } from './reconnect'
import { subscriptionChanges, videoCandidates } from './subscriptions'
import type { Publication, TrackKind } from './subscriptions'

export type DeviceError = 'denied' | 'not-found' | 'in-use' | 'other'

export class DeviceFailure extends Error {
  constructor(readonly kind: DeviceError) {
    super(`media device failure: ${kind}`)
  }
}

export type RemoteMedia = {
  identity: string
  kind: TrackKind
  attach(): HTMLMediaElement
}

export type RoomListener = {
  changed(): void
  reconnecting(): void
  reconnected(): void
  disconnected(kind: DisconnectKind): void
  subscribed(media: RemoteMedia): void
  unsubscribed(identity: string, kind: TrackKind): void
  speakers(ids: string[]): void
  playback(allowed: boolean): void
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
  setVolume(identity: string, volume: number): void
  setMicrophoneEnabled(on: boolean): Promise<void>
  // Returns the local preview while the camera is on.
  setCameraEnabled(on: boolean): Promise<HTMLMediaElement | null>
  startAudio(): Promise<void>
}

export type RoomFactory = (listener: RoomListener) => Promise<MediaRoom>

export type LinkState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'retrying' | 'waiting' | 'stopped'

export type DeviceState = { on: boolean; busy: boolean; error: DeviceError | null }

export interface MediaView {
  setLink(state: LinkState): void
  setMic(state: DeviceState): void
  setCamera(state: DeviceState): void
  setPlaybackBlocked(blocked: boolean): void
  addAudio(el: HTMLMediaElement): void
  showVideo(identity: string, name: string, el: HTMLMediaElement): void
  hideVideo(identity: string): void
  showSelfVideo(el: HTMLMediaElement | null): void
  clear(): void
}

export type MediaControls = {
  toggleMic(): void
  toggleCamera(): void
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
  private link: LinkState = 'idle'
  private attempt = 0
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private selfId: string | null = null
  private readonly players = new Map<string, Placed>()
  private nearby: ReadonlySet<string> = new Set()
  private readonly volumes = new Map<string, number>()
  private speakers: readonly string[] = []
  private speaking: ReadonlySet<string> = new Set()
  private readonly speakingListeners = new Set<SpeakingListener>()
  private mic: DeviceState
  private camera: DeviceState = { on: false, busy: false, error: null }
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
      case 'nearby':
        this.nearby = new Set(msg.d.ids)
        this.sync(true)
        return this.emitSpeaking()
    }
  }

  // The game socket dropping keeps the room: the next nearby reconciles it.
  setConnectionStatus(status: ConnectionStatus): void {
    if (status === 'replaced' || status === 'expired') this.stop()
  }

  stop(): void {
    if (this.link === 'stopped') return
    if (this.link === 'idle') {
      this.link = 'stopped'
      return
    }
    this.setLink('stopped')
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

  private onMedia(grant: Media): void {
    if (this.link === 'stopped') return
    this.grant = grant
    this.view.setMic(this.mic)
    this.view.setCamera(this.camera)
    if (this.link === 'idle' || this.link === 'waiting') void this.connect()
  }

  private async connect(): Promise<void> {
    const grant = this.grant
    if (!grant) return
    this.setLink('connecting')
    let room: MediaRoom
    try {
      room = this.room ?? (await this.createRoom(this.listener))
      this.room = room
      await room.connect(grant.url, grant.token)
    } catch {
      if (this.link === 'connecting') this.lost('other')
      return
    }
    if (this.link !== 'connecting') {
      void room.disconnect()
      return
    }
    this.attempt = 0
    this.setLink('connected')
    this.view.setPlaybackBlocked(!room.canPlaybackAudio)
    this.sync(true)
    if (this.mic.on) await this.applyMic()
    if (this.camera.on) await this.applyCamera()
  }

  private lost(kind: DisconnectKind): void {
    this.resetMedia()
    switch (disconnectAction(kind, this.grant, this.now())) {
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
    },
    disconnected: (kind) => {
      if (this.link === 'connected' || this.link === 'reconnecting') this.lost(kind)
    },
    subscribed: (media) => {
      const el = media.attach()
      if (media.kind === 'audio') return this.view.addAudio(el)
      this.view.showVideo(media.identity, this.players.get(media.identity)?.name ?? media.identity, el)
    },
    unsubscribed: (identity, kind) => {
      if (kind === 'video') this.view.hideVideo(identity)
    },
    speakers: (ids) => {
      this.speakers = ids
      this.emitSpeaking()
    },
    playback: (allowed) => this.view.setPlaybackBlocked(!allowed),
  }

  private sync(full: boolean): void {
    const room = this.room
    if (!room || (this.link !== 'connected' && this.link !== 'reconnecting')) return

    const pubs = room.publications()
    const video = nearest(videoCandidates(pubs, this.nearby), (id) => this.distanceTo(id), VIDEO_LIMIT)
    for (const change of subscriptionChanges(pubs, this.nearby, video)) {
      room.setSubscribed(change.identity, change.sid, change.subscribe)
      if (change.kind === 'video' && !change.subscribe) this.view.hideVideo(change.identity)
    }

    if (full) this.volumes.clear()
    for (const id of full ? room.participants() : this.nearby) {
      const volume = this.nearby.has(id) ? volumeAt(this.distanceTo(id)) : 0
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

  private async applyMic(): Promise<void> {
    const room = this.room
    if (!room || this.link !== 'connected') return
    const on = this.mic.on
    this.setMic({ on, busy: true, error: null })
    try {
      await room.setMicrophoneEnabled(on)
      this.setMic({ on, busy: false, error: null })
    } catch (err) {
      this.setMic({ on: false, busy: false, error: deviceError(err) })
    }
  }

  private async applyCamera(): Promise<void> {
    const room = this.room
    if (!room || this.link !== 'connected') return
    const on = this.camera.on
    this.setCamera({ on, busy: true, error: null })
    try {
      this.view.showSelfVideo(await room.setCameraEnabled(on))
      this.setCamera({ on, busy: false, error: null })
    } catch (err) {
      this.view.showSelfVideo(null)
      this.setCamera({ on: false, busy: false, error: deviceError(err) })
    }
  }

  private resetMedia(): void {
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
