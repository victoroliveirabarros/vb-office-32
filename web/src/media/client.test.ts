import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Player, ServerMessage } from '../net/protocol'
import { DeviceFailure, MediaClient } from './client'
import type { DeviceState, LinkState, MediaRoom, MediaView, RoomListener, ScreenState } from './client'
import type { MediaPrefs } from './prefs'
import type { Publication, TrackSource } from './subscriptions'

const NOW = 1_800_000_000_000
const URL = 'ws://localhost:7880'

class FakeRoom implements MediaRoom {
  canPlaybackAudio = true
  connects: string[] = []
  connectError: Error | null = null
  disconnects = 0
  pubs: Publication[] = []
  remote: string[] = []
  readonly volumes = new Map<string, number>()
  mic: boolean[] = []
  camera: boolean[] = []
  micError: Error | null = null
  // Holds the next camera call until resolved.
  cameraGate: Promise<void> | null = null
  audioStarts = 0
  // Every subscriber list sent; log also records connects and the mic.
  allowed: string[][] = []
  log: string[] = []
  screen: boolean[] = []
  screenResult: boolean | Error = true
  // Holds the next screen call until resolved.
  screenGate: Promise<void> | null = null

  constructor(readonly listener: RoomListener) {}

  async connect(_url: string, token: string): Promise<void> {
    this.connects.push(token)
    this.log.push(`connect ${token}`)
    if (this.connectError) throw this.connectError
  }
  setAllowedSubscribers(ids: readonly string[]): void {
    this.allowed.push([...ids])
    this.log.push(`allow [${ids.join(',')}]`)
  }
  async setScreenShareEnabled(on: boolean): Promise<boolean> {
    this.screen.push(on)
    const gate = this.screenGate
    this.screenGate = null
    await gate
    if (!on) return false
    const result = this.screenResult
    if (result instanceof Error) throw result
    return result
  }
  async disconnect(): Promise<void> {
    this.disconnects++
  }
  participants(): string[] {
    return this.remote
  }
  publications(): Publication[] {
    return this.pubs.map((p) => ({ ...p }))
  }
  setSubscribed(_identity: string, sid: string, subscribed: boolean): void {
    const pub = this.pubs.find((p) => p.sid === sid)
    if (pub) pub.desired = subscribed
  }
  setVolume(identity: string, volume: number): void {
    this.volumes.set(identity, volume)
  }
  async setMicrophoneEnabled(on: boolean): Promise<void> {
    this.mic.push(on)
    this.log.push(`mic ${on}`)
    if (this.micError) throw this.micError
  }
  async setCameraEnabled(on: boolean): Promise<HTMLMediaElement | null> {
    this.camera.push(on)
    const gate = this.cameraGate
    this.cameraGate = null
    await gate
    return on ? element('preview') : null
  }
  async startAudio(): Promise<void> {
    this.audioStarts++
    this.canPlaybackAudio = true
  }

  publish(identity: string, source: TrackSource, muted = false): void {
    if (!this.remote.includes(identity)) this.remote.push(identity)
    this.pubs.push({ identity, sid: `${identity}-${source}`, source, desired: false, muted })
    this.listener.changed()
  }

  unpublish(identity: string, source: TrackSource): void {
    this.pubs = this.pubs.filter((p) => p.sid !== `${identity}-${source}`)
    this.listener.changed()
  }

  subscribed(): string[] {
    return this.pubs.filter((p) => p.desired).map((p) => p.sid)
  }
}

class FakeView implements MediaView {
  links: LinkState[] = []
  mic: DeviceState | null = null
  camera: DeviceState | null = null
  screen: ScreenState | null = null
  stage: string | null = null
  blocked = false
  audio: HTMLMediaElement[] = []
  readonly videos = new Map<string, string>()
  self: HTMLMediaElement | null = null

  setLink(state: LinkState): void {
    this.links.push(state)
  }
  setMic(state: DeviceState): void {
    this.mic = state
  }
  setCamera(state: DeviceState): void {
    this.camera = state
  }
  setScreen(state: ScreenState): void {
    this.screen = state
  }
  showScreen(identity: string): void {
    this.stage = identity
  }
  hideScreen(identity: string): void {
    if (this.stage === identity) this.stage = null
  }
  setPlaybackBlocked(blocked: boolean): void {
    this.blocked = blocked
  }
  addAudio(el: HTMLMediaElement): void {
    this.audio.push(el)
  }
  showVideo(identity: string, name: string): void {
    this.videos.set(identity, name)
  }
  hideVideo(identity: string): void {
    this.videos.delete(identity)
  }
  showSelfVideo(el: HTMLMediaElement | null): void {
    this.self = el
  }
  clear(): void {
    this.audio = []
    this.videos.clear()
    this.self = null
    this.stage = null
  }
  get link(): LinkState | undefined {
    return this.links.at(-1)
  }
}

class MemoryPrefs implements MediaPrefs {
  constructor(public muted = false) {}
  micMuted(): boolean {
    return this.muted
  }
  setMicMuted(muted: boolean): void {
    this.muted = muted
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {}
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}

function element(name: string): HTMLMediaElement {
  return { id: name } as HTMLMediaElement
}

const player = (id: string, x: number, y = 0): Player => ({ id, name: id.toUpperCase(), x, y, dir: 'down' })

const welcome = (players: Player[]): ServerMessage => ({
  t: 'welcome',
  d: { selfId: 'me', mapId: 'office', tickRate: 20, stepMs: 150, players: [player('me', 0), ...players] },
})
const media = (token: string, expiresAt = NOW + 600_000): ServerMessage => ({ t: 'media', d: { url: URL, token, expiresAt } })
const nearby = (...ids: string[]): ServerMessage => ({ t: 'nearby', d: { ids } })
const zone = (id = '', kind: 'meeting' | 'private' = 'meeting'): ServerMessage => ({
  t: 'zone',
  d: id === '' ? { id } : { id, name: id, kind },
})
const moved = (id: string, x: number, y = 0): ServerMessage => ({
  t: 'state',
  d: { tick: 1, ack: 0, players: [{ id, x, y, dir: 'down' }] },
})

describe('MediaClient', () => {
  let rooms: FakeRoom[]
  let view: FakeView
  let prefs: MemoryPrefs
  let loading: Promise<void> | null

  const setup = (muted = false, configure?: (room: FakeRoom) => void) => {
    prefs = new MemoryPrefs(muted)
    const client = new MediaClient({
      createRoom: async (listener) => {
        await loading
        const room = new FakeRoom(listener)
        configure?.(room)
        rooms.push(room)
        return room
      },
      view,
      prefs,
      now: () => Date.now(),
    })
    return client
  }

  const room = (): FakeRoom => {
    const r = rooms[0]
    if (!r) throw new Error('no room created')
    return r
  }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    rooms = []
    loading = null
    view = new FakeView()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('creates the room only when a grant arrives and turns the mic on', async () => {
    const client = setup()
    client.handle(welcome([]))
    client.handle(nearby())
    expect(rooms).toHaveLength(0)

    client.handle(media('t1'))
    await vi.runAllTimersAsync()
    expect(room().connects).toEqual(['t1'])
    expect(client.state).toBe('connected')
    expect(room().mic).toEqual([true])
    expect(room().camera).toEqual([])
    expect(view.mic).toEqual({ on: true, busy: false, error: null })
  })

  it('remembers a muted mic and does not open it on join', async () => {
    const client = setup(true)
    client.handle(welcome([]))
    client.handle(media('t1'))
    await vi.runAllTimersAsync()
    expect(room().mic).toEqual([])

    client.toggleMic()
    await vi.runAllTimersAsync()
    expect(room().mic).toEqual([true])
    expect(prefs.muted).toBe(false)

    client.toggleMic()
    await vi.runAllTimersAsync()
    expect(room().mic).toEqual([true, false])
    expect(prefs.muted).toBe(true)
  })

  it('subscribes audio of everyone nearby and video of the 8 closest cameras', async () => {
    const others = Array.from({ length: 10 }, (_, i) => player(`p${i}`, i + 1))
    const client = setup()
    client.handle(welcome([...others, player('far', 30)]))
    client.handle(media('t1'))
    await vi.runAllTimersAsync()
    const r = room()
    for (const p of [...others, player('far', 30)]) {
      r.publish(p.id, 'microphone')
      r.publish(p.id, 'camera', p.id === 'p0')
    }
    expect(r.subscribed()).toEqual([])

    client.handle(nearby(...others.map((p) => p.id)))
    expect(r.subscribed().filter((sid) => sid.endsWith('microphone'))).toHaveLength(10)
    expect(r.subscribed().filter((sid) => sid.endsWith('camera'))).toEqual(
      ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8'].map((id) => `${id}-camera`),
    )

    client.handle(moved('p9', 1, 1))
    expect(r.subscribed()).toContain('p9-camera')
    expect(r.subscribed()).not.toContain('p8-camera')

    client.handle(nearby('p1'))
    expect(r.subscribed()).toEqual(['p1-microphone', 'p1-camera'])
  })

  it('keeps the 8th camera until another is clearly closer', async () => {
    const others = Array.from({ length: 8 }, (_, i) => player(`p${i + 1}`, i + 1))
    const client = setup()
    client.handle(welcome([...others, player('p9', 8, 1)]))
    client.handle(media('t1'))
    await vi.runAllTimersAsync()
    const r = room()
    for (const p of [...others, player('p9', 8, 1)]) r.publish(p.id, 'camera')
    client.handle(nearby(...others.map((p) => p.id), 'p9'))
    expect(r.subscribed()).toContain('p8-camera')

    client.handle(moved('p8', 9))
    expect(r.subscribed()).toContain('p8-camera')
    expect(r.subscribed()).not.toContain('p9-camera')
    client.handle(moved('p8', 8))
    client.handle(moved('p9', 8, 1))
    expect(r.subscribed()).toContain('p8-camera')
    expect(r.subscribed()).not.toContain('p9-camera')

    client.handle(moved('p9', 6, 1))
    expect(r.subscribed()).toContain('p9-camera')
    expect(r.subscribed()).not.toContain('p8-camera')
  })

  it('hides a tile as soon as its video is unsubscribed', async () => {
    const client = setup()
    client.handle(welcome([player('ana', 2)]))
    client.handle(media('t1'))
    await vi.runAllTimersAsync()
    room().publish('ana', 'camera')
    client.handle(nearby('ana'))
    room().listener.subscribed({ identity: 'ana', source: 'camera', attach: () => element('ana') })
    expect(view.videos.get('ana')).toBe('ANA')

    client.handle(nearby())
    expect(view.videos.has('ana')).toBe(false)
  })

  it('sets volume by distance, 0 outside the set, and follows movement', async () => {
    const client = setup()
    client.handle(welcome([player('ana', 1), player('bob', 4), player('cid', 9)]))
    client.handle(media('t1'))
    await vi.runAllTimersAsync()
    const r = room()
    r.remote = ['ana', 'bob', 'cid']

    client.handle(nearby('ana', 'bob'))
    expect(r.volumes.get('ana')).toBe(1)
    expect(r.volumes.get('bob')).toBeCloseTo(0.2)
    expect(r.volumes.get('cid')).toBe(0)

    client.handle(moved('bob', 2))
    expect(r.volumes.get('bob')).toBeCloseTo(1 - 0.8 / 3)
    client.handle(moved('me', 2))
    expect(r.volumes.get('bob')).toBe(1)
    expect(r.volumes.get('ana')).toBe(1)
  })

  it('attaches subscribed audio', async () => {
    const client = setup()
    client.handle(welcome([]))
    client.handle(media('t1'))
    await vi.runAllTimersAsync()
    room().listener.subscribed({ identity: 'ana', source: 'microphone', attach: () => element('a') })
    expect(view.audio).toHaveLength(1)
  })

  it('never reconnects the room on a renewed grant', async () => {
    const client = setup()
    client.handle(welcome([]))
    client.handle(media('t1'))
    await vi.runAllTimersAsync()
    client.handle(media('t2'))
    await vi.runAllTimersAsync()
    expect(room().connects).toEqual(['t1'])
  })

  it('keeps the room while the game socket reconnects and drops it when replaced', async () => {
    const client = setup()
    client.handle(welcome([]))
    client.handle(media('t1'))
    await vi.runAllTimersAsync()
    client.setConnectionStatus('reconnecting')
    expect(room().disconnects).toBe(0)

    client.setConnectionStatus('replaced')
    expect(room().disconnects).toBe(1)
    expect(client.state).toBe('stopped')
    room().listener.disconnected('client')
    client.handle(media('t2'))
    await vi.runAllTimersAsync()
    expect(room().connects).toEqual(['t1'])
  })

  it('stays out of sight when replaced before any grant', async () => {
    const client = setup()
    client.handle(welcome([]))
    client.setConnectionStatus('replaced')
    client.handle(media('t1'))
    await vi.runAllTimersAsync()
    expect(rooms).toHaveLength(0)
    expect(view.links).toEqual([])
  })

  it('drops a room that finished loading after the tab was replaced', async () => {
    const load = deferred()
    loading = load.promise
    const client = setup()
    client.handle(welcome([]))
    client.handle(media('t1'))
    client.setConnectionStatus('replaced')
    load.resolve()
    await vi.runAllTimersAsync()
    expect(room().connects).toEqual([])
    expect(room().disconnects).toBe(1)
    expect(client.state).toBe('stopped')
  })

  it('mutes at once while reconnecting and applies the rest once reconnected', async () => {
    const client = setup()
    client.handle(welcome([]))
    client.handle(media('t1'))
    await vi.runAllTimersAsync()
    const r = room()

    r.listener.reconnecting()
    client.toggleMic()
    client.toggleCamera()
    await vi.runAllTimersAsync()
    expect(r.mic).toEqual([true, false])
    expect(r.camera).toEqual([])
    expect(view.camera).toEqual({ on: true, busy: false, error: null })

    r.listener.reconnected()
    await vi.runAllTimersAsync()
    expect(r.mic).toEqual([true, false])
    expect(r.camera).toEqual([true])
    expect(view.self).not.toBeNull()

    r.listener.reconnecting()
    client.toggleMic()
    client.toggleCamera()
    client.toggleCamera()
    await vi.runAllTimersAsync()
    r.listener.reconnected()
    await vi.runAllTimersAsync()
    expect(r.mic).toEqual([true, false, true])
    expect(r.camera).toEqual([true, false])
    expect(view.mic).toEqual({ on: true, busy: false, error: null })
    expect(view.camera).toEqual({ on: false, busy: false, error: null })
  })

  it('does not show a camera that opened after the room stopped', async () => {
    const client = setup()
    client.handle(welcome([]))
    client.handle(media('t1'))
    await vi.runAllTimersAsync()
    const open = deferred()
    room().cameraGate = open.promise
    client.toggleCamera()
    client.stop()
    open.resolve()
    await vi.runAllTimersAsync()
    expect(view.self).toBeNull()
    expect(view.camera).toEqual({ on: true, busy: false, error: null })
  })

  it('opens the camera again when the room drops while it was opening', async () => {
    const client = setup()
    client.handle(welcome([]))
    client.handle(media('t1'))
    await vi.runAllTimersAsync()
    const r = room()
    const open = deferred()
    r.cameraGate = open.promise
    client.toggleCamera()
    r.listener.disconnected('other')
    open.resolve()
    await vi.advanceTimersByTimeAsync(1)
    expect(client.state).toBe('retrying')
    expect(view.self).toBeNull()

    await vi.advanceTimersByTimeAsync(500)
    expect(client.state).toBe('connected')
    expect(r.camera).toEqual([true, true])
    expect(view.self).not.toBeNull()
  })

  it('retries a dropped room with the last grant after a backoff', async () => {
    const client = setup()
    client.handle(welcome([]))
    client.handle(media('t1'))
    client.handle(media('t2'))
    await vi.runAllTimersAsync()
    client.toggleCamera()
    await vi.runAllTimersAsync()
    expect(view.self).not.toBeNull()

    room().listener.disconnected('other')
    expect(client.state).toBe('retrying')
    expect(view.self).toBeNull()
    await vi.advanceTimersByTimeAsync(500)
    expect(room().connects).toEqual(['t1', 't2'])
    expect(client.state).toBe('connected')
    expect(room().camera).toEqual([true, true])
    expect(view.self).not.toBeNull()
  })

  it('backs off again when connecting fails', async () => {
    const client = setup()
    client.handle(welcome([]))
    client.handle(media('t1'))
    await vi.runAllTimersAsync()
    room().connectError = new Error('signal failed')
    room().listener.disconnected('other')
    await vi.advanceTimersByTimeAsync(500)
    expect(client.state).toBe('retrying')
    await vi.advanceTimersByTimeAsync(1000)
    expect(room().connects).toEqual(['t1', 't1', 't1'])
  })

  it('waits for a new grant when the last one is about to expire', async () => {
    const client = setup()
    client.handle(welcome([]))
    client.handle(media('t1', NOW + 20_000))
    await vi.runAllTimersAsync()
    room().listener.disconnected('other')
    expect(client.state).toBe('waiting')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(room().connects).toEqual(['t1'])

    client.handle(media('t2'))
    await vi.runAllTimersAsync()
    expect(room().connects).toEqual(['t1', 't2'])
    expect(client.state).toBe('connected')
  })

  it('rejoins at once when a removal lands after a fresh grant', async () => {
    const client = setup()
    client.handle(welcome([]))
    client.handle(media('t1'))
    await vi.runAllTimersAsync()
    await vi.advanceTimersByTimeAsync(60_000)

    // The game socket came back while the removal was in flight.
    client.handle(media('t2'))
    await vi.advanceTimersByTimeAsync(2_000)
    room().listener.disconnected('removed')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(room().connects).toEqual(['t1', 't2'])
    expect(client.state).toBe('connected')
  })

  it('stops for good on a duplicate identity', async () => {
    const client = setup()
    client.handle(welcome([]))
    client.handle(media('t1'))
    await vi.runAllTimersAsync()
    room().listener.disconnected('duplicate')
    expect(client.state).toBe('stopped')
    client.handle(media('t2'))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(room().connects).toEqual(['t1'])
  })

  it('reconnects with the next grant after a removal', async () => {
    const client = setup()
    client.handle(welcome([]))
    client.handle(media('t1'))
    await vi.runAllTimersAsync()
    // The server only removes after 30s off the game socket, without grants.
    await vi.advanceTimersByTimeAsync(30_000)
    room().listener.disconnected('removed')
    expect(client.state).toBe('waiting')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(room().connects).toEqual(['t1'])

    client.handle(media('t2'))
    await vi.runAllTimersAsync()
    expect(room().connects).toEqual(['t1', 't2'])
    expect(client.state).toBe('connected')
  })

  it('reports device failures and leaves the device off', async () => {
    const client = setup(false, (r) => (r.micError = new DeviceFailure('denied')))
    client.handle(welcome([]))
    client.handle(media('t1'))
    await vi.runAllTimersAsync()
    expect(view.mic).toEqual({ on: false, busy: false, error: 'denied' })
    expect(prefs.muted).toBe(false)
  })

  it('shows speaking only for itself and nearby players', async () => {
    const client = setup()
    const seen: string[][] = []
    client.onSpeaking((ids) => seen.push([...ids].sort()))
    client.handle(welcome([player('ana', 1), player('bob', 9)]))
    client.handle(media('t1'))
    await vi.runAllTimersAsync()
    client.handle(nearby('ana'))
    room().listener.speakers(['bob', 'ana', 'me'])
    client.handle(nearby())
    expect(seen).toEqual([[], ['ana', 'me'], ['me']])
  })

  it('allows nobody before connecting and the nearby set before opening devices', async () => {
    const client = setup()
    client.handle(welcome([player('ana', 1)]))
    client.handle(nearby('ana'))
    client.handle(media('t1'))
    await vi.runAllTimersAsync()
    expect(room().log).toEqual(['allow []', 'connect t1', 'allow [ana]', 'mic true'])
  })

  it('updates permissions on each nearby, only when they change', async () => {
    const client = setup()
    client.handle(welcome([player('ana', 1), player('bob', 2)]))
    client.handle(media('t1'))
    await vi.runAllTimersAsync()
    const r = room()
    r.allowed = []
    client.handle(nearby('bob', 'ana'))
    client.handle(nearby('ana', 'bob'))
    client.handle(nearby('ana'))
    expect(r.allowed).toEqual([['ana', 'bob'], ['ana']])
  })

  it('allows nobody while the game socket is down and from a welcome until the next nearby', async () => {
    const client = setup()
    client.handle(welcome([player('ana', 1)]))
    client.handle(media('t1'))
    await vi.runAllTimersAsync()
    const r = room()
    client.handle(nearby('ana'))
    r.allowed = []

    client.setConnectionStatus('reconnecting')
    expect(r.allowed).toEqual([[]])
    client.setConnectionStatus('open')
    client.handle(welcome([player('ana', 1)]))
    client.handle(nearby('ana'))
    expect(r.allowed).toEqual([[], ['ana']])

    client.handle(welcome([player('ana', 1)]))
    expect(r.allowed).toEqual([[], ['ana'], []])
  })

  it('allows the nearby set again after the room reconnects', async () => {
    const client = setup()
    client.handle(welcome([player('ana', 1)]))
    client.handle(media('t1'))
    await vi.runAllTimersAsync()
    client.handle(nearby('ana'))
    const r = room()
    r.log = []
    r.listener.disconnected('other')
    await vi.advanceTimersByTimeAsync(500)
    expect(r.log).toEqual(['allow []', 'connect t1', 'allow [ana]', 'mic true'])
  })

  it('plays everyone in the same zone at full volume', async () => {
    const client = setup()
    client.handle(welcome([player('ana', 3), player('bob', 8)]))
    client.handle(media('t1'))
    await vi.runAllTimersAsync()
    const r = room()
    r.remote = ['ana', 'bob']
    client.handle(nearby('ana'))
    expect(r.volumes.get('ana')).toBeCloseTo(1 - 1.6 / 3)

    client.handle(zone('sala-1'))
    client.handle(nearby('ana', 'bob'))
    expect(r.volumes.get('ana')).toBe(1)
    expect(r.volumes.get('bob')).toBe(1)

    client.handle(zone())
    client.handle(nearby('ana'))
    expect(r.volumes.get('ana')).toBeCloseTo(1 - 1.6 / 3)
    expect(r.volumes.get('bob')).toBe(0)
  })

  it('shares the screen only in a meeting room and stops on leaving it', async () => {
    const client = setup()
    client.handle(welcome([]))
    client.handle(media('t1'))
    await vi.runAllTimersAsync()
    const r = room()
    client.toggleScreen()
    client.handle(zone('cabine', 'private'))
    client.toggleScreen()
    expect(r.screen).toEqual([])
    expect(view.screen).toMatchObject({ on: false, meeting: false })

    client.handle(zone('sala-1'))
    expect(view.screen).toMatchObject({ on: false, meeting: true })
    client.toggleScreen()
    await vi.runAllTimersAsync()
    expect(r.screen).toEqual([true])
    expect(view.screen).toEqual({ on: true, busy: false, error: null, meeting: true, taken: false })

    client.handle(zone())
    await vi.runAllTimersAsync()
    expect(r.screen).toEqual([true, false])
    expect(view.screen).toMatchObject({ on: false, busy: false, meeting: false })
  })

  it('stops a share whose picker was still open when leaving the room', async () => {
    const client = setup()
    client.handle(welcome([]))
    client.handle(zone('sala-1'))
    client.handle(media('t1'))
    await vi.runAllTimersAsync()
    const r = room()
    const picked = deferred()
    r.screenGate = picked.promise
    client.toggleScreen()
    client.handle(zone())
    picked.resolve()
    await vi.runAllTimersAsync()
    expect(r.screen).toEqual([true, false])
    expect(view.screen).toMatchObject({ on: false, busy: false })
  })

  it('treats a cancelled picker as off without an error and reports failures', async () => {
    const client = setup()
    client.handle(welcome([]))
    client.handle(zone('sala-1'))
    client.handle(media('t1'))
    await vi.runAllTimersAsync()
    const r = room()
    r.screenResult = false
    client.toggleScreen()
    await vi.runAllTimersAsync()
    expect(view.screen).toMatchObject({ on: false, busy: false, error: null })

    r.screenResult = new DeviceFailure('other')
    client.toggleScreen()
    await vi.runAllTimersAsync()
    expect(view.screen).toMatchObject({ on: false, busy: false, error: 'other' })
    expect(r.screen).toEqual([true, true])
  })

  it('follows a share stopped from the browser', async () => {
    const client = setup()
    client.handle(welcome([]))
    client.handle(zone('sala-1'))
    client.handle(media('t1'))
    await vi.runAllTimersAsync()
    const r = room()
    client.toggleScreen()
    await vi.runAllTimersAsync()
    r.listener.screenEnded()
    expect(view.screen).toMatchObject({ on: false, busy: false })
    client.toggleScreen()
    await vi.runAllTimersAsync()
    expect(r.screen).toEqual([true, true])
  })

  it('does not share again by itself after the room drops', async () => {
    const client = setup()
    client.handle(welcome([]))
    client.handle(zone('sala-1'))
    client.handle(media('t1'))
    await vi.runAllTimersAsync()
    const r = room()
    client.toggleScreen()
    await vi.runAllTimersAsync()
    r.listener.disconnected('other')
    expect(view.screen).toMatchObject({ on: false })
    await vi.advanceTimersByTimeAsync(500)
    expect(client.state).toBe('connected')
    expect(r.screen).toEqual([true])
  })

  it('watches one screen of the room, keeping the current one', async () => {
    const client = setup()
    client.handle(welcome([player('ana', 1), player('bob', 2), player('cid', 3)]))
    client.handle(media('t1'))
    await vi.runAllTimersAsync()
    const r = room()
    r.publish('bob', 'screen')
    r.publish('cid', 'screen')
    client.handle(nearby('bob', 'cid'))
    expect(r.subscribed()).not.toContain('bob-screen')
    expect(view.screen).toMatchObject({ taken: true })

    client.handle(zone('sala-1'))
    expect(r.subscribed().filter((sid) => sid.endsWith('screen'))).toEqual(['bob-screen'])
    r.listener.subscribed({ identity: 'bob', source: 'screen', attach: () => element('bob') })
    expect(view.stage).toBe('bob')

    r.publish('ana', 'screen')
    client.handle(nearby('ana', 'bob', 'cid'))
    expect(r.subscribed().filter((sid) => sid.endsWith('screen'))).toEqual(['bob-screen'])

    r.unpublish('bob', 'screen')
    r.listener.unsubscribed('bob', 'screen')
    expect(view.stage).toBeNull()
    expect(r.subscribed().filter((sid) => sid.endsWith('screen'))).toEqual(['ana-screen'])

    client.handle(nearby('cid'))
    expect(r.subscribed().filter((sid) => sid.endsWith('screen'))).toEqual(['cid-screen'])
    client.handle(zone())
    expect(r.subscribed().filter((sid) => sid.endsWith('screen'))).toEqual([])
  })

  it('does not start a share while someone else in the room shares', async () => {
    const client = setup()
    client.handle(welcome([player('ana', 1)]))
    client.handle(zone('sala-1'))
    client.handle(media('t1'))
    await vi.runAllTimersAsync()
    const r = room()
    r.publish('ana', 'screen')
    client.handle(nearby('ana'))
    client.toggleScreen()
    expect(r.screen).toEqual([])
    r.unpublish('ana', 'screen')
    expect(view.screen).toMatchObject({ taken: false })
    client.toggleScreen()
    await vi.runAllTimersAsync()
    expect(r.screen).toEqual([true])
  })

  it('offers to unlock audio when the browser blocks playback', async () => {
    const client = setup()
    client.handle(welcome([]))
    client.handle(media('t1'))
    await vi.runAllTimersAsync()
    room().canPlaybackAudio = false
    room().listener.playback(false)
    expect(view.blocked).toBe(true)
    client.startAudio()
    await vi.runAllTimersAsync()
    expect(room().audioStarts).toBe(1)
    expect(view.blocked).toBe(false)
  })
})
