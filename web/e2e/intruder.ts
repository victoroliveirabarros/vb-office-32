// Development-only harness for docs/livekit.md: one page per participant,
// driven by intruder.mjs through the DevTools protocol. role=honest runs the
// real MediaClient; role=intruder holds a valid session but subscribes to
// everything in the LiveKit room, as a modified client would.
import { Room, RoomEvent } from 'livekit-client'
import type { RemoteTrack } from 'livekit-client'
import { Grid } from '../src/game/grid'
import type { Tile } from '../src/game/grid'
import { MediaClient } from '../src/media/client'
import type { DeviceState, LinkState, MediaView, ScreenState } from '../src/media/client'
import { createLiveKitRoom } from '../src/media/livekit'
import { Connection, wsUrl } from '../src/net/connection'
import type { Dir, Media, ServerMessage } from '../src/net/protocol'

type Logged = { at: number; type: string; [key: string]: unknown }

type Inbound = { audio: number; video: number; streams: Record<string, number> }

type Harness = {
  role: string
  selfId: string | null
  pos: Tile | null
  zone: string
  nearby: string[]
  link: string
  screen: ScreenState | null
  events: Logged[]
  walkTo(x: number, y: number): Promise<Tile | null>
  // inbound totals the bytes received; streams has them per inbound stream.
  inbound(): Promise<Inbound>
  // video lists each incoming video stream.
  video(): Promise<{ id: string; bytes: number; width: number; height: number; fps: number }[]>
  // sample reads inbound() every 50 ms for ms milliseconds.
  sample(ms: number): Promise<(Inbound & { at: number })[]>
  // The intruder's view of what others publish, permitted or not.
  publications(): { identity: string; source: string; permission: string; subscribed: boolean }[]
  toggleCamera(): void
  toggleScreen(): void
}

declare global {
  interface Window {
    e2e: Harness
  }
}

// Every peer connection of the page, to count what actually arrives.
const peers: RTCPeerConnection[] = []
const NativePeer = window.RTCPeerConnection
window.RTCPeerConnection = class extends NativePeer {
  constructor(...args: ConstructorParameters<typeof RTCPeerConnection>) {
    super(...args)
    peers.push(this)
  }
}

const params = new URLSearchParams(location.search)
const role = params.get('role') === 'intruder' ? 'intruder' : 'honest'
const name = params.get('name') ?? 'Teste'
const box = document.getElementById('media') ?? document.body
document.getElementById('role')?.append(`${role} ${name}`)

const events: Logged[] = []
const log = (type: string, data: Record<string, unknown> = {}) => events.push({ at: Date.now(), type, ...data })

const connection = new Connection(wsUrl(name))
const grid = fetch('/maps/office.tmj')
  .then((res) => res.json())
  .then((map: unknown) => Grid.fromTiled(map))

const harness: Harness = {
  role,
  selfId: null,
  pos: null,
  zone: '',
  nearby: [],
  link: 'idle',
  screen: null,
  events,
  walkTo,
  inbound,
  video,
  sample,
  publications: () => [],
  toggleCamera: () => {},
  toggleScreen: () => {},
}
window.e2e = harness

connection.onMessage((msg) => track(msg))
connection.onStatus((status) => log('socket', { status }))

function track(msg: ServerMessage): void {
  switch (msg.t) {
    case 'welcome': {
      harness.selfId = msg.d.selfId
      const self = msg.d.players.find((p) => p.id === msg.d.selfId)
      if (self) harness.pos = { x: self.x, y: self.y }
      return
    }
    case 'state':
      for (const p of msg.d.players) if (p.id === harness.selfId) harness.pos = { x: p.x, y: p.y }
      return
    case 'zone':
      harness.zone = msg.d.id
      log('zone', { id: msg.d.id })
      return
    case 'nearby':
      harness.nearby = msg.d.ids
      log('nearby', { ids: msg.d.ids })
      return
  }
}

const DIRS: [Dir, Tile][] = [
  ['up', { x: 0, y: -1 }],
  ['down', { x: 0, y: 1 }],
  ['left', { x: -1, y: 0 }],
  ['right', { x: 1, y: 0 }],
]

function firstStep(g: Grid, from: Tile, to: Tile): Dir | null {
  const key = (t: Tile) => t.y * g.width + t.x
  const first = new Map<number, Dir>()
  const queue: Tile[] = [from]
  const seen = new Set([key(from)])
  for (let t = queue.shift(); t; t = queue.shift()) {
    if (t.x === to.x && t.y === to.y) return first.get(key(t)) ?? null
    for (const [dir, d] of DIRS) {
      const next = { x: t.x + d.x, y: t.y + d.y }
      if (g.isBlocked(next.x, next.y) || seen.has(key(next))) continue
      seen.add(key(next))
      first.set(key(next), first.get(key(t)) ?? dir)
      queue.push(next)
    }
  }
  return null
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// The server ignores a move whose seq is not above the last one.
let seq = 0

// walkTo sends one move at a time and waits for the server to apply it.
async function walkTo(x: number, y: number): Promise<Tile | null> {
  const g = await grid
  for (let i = 0; i < 200; i++) {
    const pos = harness.pos
    if (!pos) {
      await sleep(50)
      continue
    }
    if (pos.x === x && pos.y === y) return pos
    const dir = firstStep(g, pos, { x, y })
    if (!dir) return pos
    connection.send({ t: 'move', d: { seq: ++seq, dir } })
    for (let waited = 0; waited < 1000 && harness.pos === pos; waited += 20) await sleep(20)
  }
  return harness.pos
}

// A stream's stats vanish once it is unsubscribed, so totals can shrink;
// growth is told per stream.
async function inbound(): Promise<Inbound> {
  const total: Inbound = { audio: 0, video: 0, streams: {} }
  for (const [i, pc] of peers.entries()) {
    if (pc.connectionState === 'closed') continue
    const stats = await pc.getStats()
    stats.forEach((s: { type?: string; kind?: string; id?: string; bytesReceived?: number }) => {
      if (s.type !== 'inbound-rtp' || typeof s.bytesReceived !== 'number') return
      if (s.kind === 'audio') total.audio += s.bytesReceived
      else if (s.kind === 'video') total.video += s.bytesReceived
      total.streams[`${i}/${s.id ?? ''}`] = s.bytesReceived
    })
  }
  return total
}

type VideoStats = { type?: string; kind?: string; id?: string; bytesReceived?: number; frameWidth?: number; frameHeight?: number; framesPerSecond?: number }

async function video(): Promise<{ id: string; bytes: number; width: number; height: number; fps: number }[]> {
  const list: { id: string; bytes: number; width: number; height: number; fps: number }[] = []
  for (const pc of peers) {
    if (pc.connectionState === 'closed') continue
    const stats = await pc.getStats()
    stats.forEach((s: VideoStats) => {
      if (s.type !== 'inbound-rtp' || s.kind !== 'video') return
      list.push({ id: s.id ?? '', bytes: s.bytesReceived ?? 0, width: s.frameWidth ?? 0, height: s.frameHeight ?? 0, fps: s.framesPerSecond ?? 0 })
    })
  }
  return list
}

async function sample(ms: number): Promise<(Inbound & { at: number })[]> {
  const samples: (Inbound & { at: number })[] = []
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) samples.push({ at: Date.now(), ...(await inbound()) })
  return samples
}

function honest(): void {
  const view: MediaView = {
    setLink(state: LinkState) {
      harness.link = state
      log('link', { state })
    },
    setMic(state: DeviceState) {
      log('mic', { ...state })
    },
    setCamera(state: DeviceState) {
      log('camera', { ...state })
    },
    setScreen(state: ScreenState) {
      harness.screen = state
      log('screen', { ...state })
    },
    setPlaybackBlocked() {},
    addAudio(el) {
      box.append(el)
      log('show', { source: 'microphone' })
    },
    showVideo(identity, _name, el) {
      box.append(el)
      log('show', { source: 'camera', identity })
    },
    hideVideo(identity) {
      log('hide', { source: 'camera', identity })
    },
    showSelfVideo() {},
    showScreen(identity, _name, el) {
      el.style.width = '1280px'
      el.style.height = '720px'
      box.append(el)
      log('show', { source: 'screen', identity })
    },
    hideScreen(identity) {
      log('hide', { source: 'screen', identity })
    },
    clear() {
      box.replaceChildren()
    },
  }
  const media = new MediaClient({
    createRoom: async (listener) => createLiveKitRoom(listener),
    view,
    prefs: { micMuted: () => false, setMicMuted: () => {} },
  })
  connection.onMessage((msg) => media.handle(msg))
  connection.onStatus((status) => media.setConnectionStatus(status))
  harness.toggleCamera = () => media.toggleCamera()
  harness.toggleScreen = () => media.toggleScreen()
}

function intruder(): void {
  const room = new Room({ adaptiveStream: false, dynacast: false })
  const label = (t: RemoteTrack) => t.source
  room
    .on(RoomEvent.Connected, () => (harness.link = 'connected'))
    .on(RoomEvent.TrackPublished, (pub, p) => log('published', { identity: p.identity, source: pub.source }))
    .on(RoomEvent.TrackSubscribed, (track, _, p) => {
      box.append(track.attach())
      log('subscribed', { identity: p.identity, source: label(track) })
    })
    .on(RoomEvent.TrackUnsubscribed, (track, _, p) => {
      track.detach().forEach((el) => el.remove())
      log('unsubscribed', { identity: p.identity, source: label(track) })
    })
    .on(RoomEvent.TrackSubscriptionPermissionChanged, (pub, status, p) =>
      log('permission', { identity: p.identity, source: pub.source, status }),
    )
    .on(RoomEvent.TrackSubscriptionFailed, (sid, p, reason) => log('failed', { identity: p.identity, sid, reason }))
    .on(RoomEvent.Disconnected, (reason) => log('disconnected', { reason }))
  harness.publications = () =>
    [...room.remoteParticipants.values()].flatMap((p) =>
      [...p.trackPublications.values()].map((pub) => ({
        identity: p.identity,
        source: pub.source,
        permission: pub.permissionStatus,
        subscribed: pub.isSubscribed,
      })),
    )
  let grant: Media | null = null
  connection.onMessage((msg) => {
    if (msg.t !== 'media' || grant) return
    grant = msg.d
    room.connect(msg.d.url, msg.d.token, { autoSubscribe: true }).catch((err: unknown) => log('error', { err: String(err) }))
  })
}

if (role === 'intruder') intruder()
else honest()
connection.connect()
