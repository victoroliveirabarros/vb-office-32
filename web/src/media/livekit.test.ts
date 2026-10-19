import { AudioPresets, RoomEvent, ScreenSharePresets, Track } from 'livekit-client'
import type { RoomOptions } from 'livekit-client'
import { describe, expect, it, vi } from 'vitest'
import { DeviceFailure } from './client'
import type { RoomListener } from './client'
import { createLiveKitRoom } from './livekit'

type Handler = (...args: never[]) => unknown

type FakeTrack = { mediaStreamTrack: { readyState: 'live' | 'ended' } }

type Local = {
  permissions: unknown[][]
  screenCalls: unknown[][]
  screenError: Error | null
  published: FakeTrack | undefined
}

const track = (readyState: 'live' | 'ended'): FakeTrack => ({ mediaStreamTrack: { readyState } })

const sdk = vi.hoisted(() => ({
  rooms: [] as { options: Partial<RoomOptions>; handlers: Map<string, Handler>; localParticipant: Local }[],
}))

vi.mock('livekit-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('livekit-client')>()
  class LocalParticipant {
    permissions: unknown[][] = []
    screenCalls: unknown[][] = []
    screenError: Error | null = null
    // The screen publication's track, while published.
    published: FakeTrack | undefined
    setTrackSubscriptionPermissions(...args: unknown[]): void {
      this.permissions.push(args)
    }
    async setScreenShareEnabled(...args: unknown[]): Promise<object | undefined> {
      this.screenCalls.push(args)
      if (this.screenError) throw this.screenError
      if (!args[0]) {
        if (this.published) this.published.mediaStreamTrack.readyState = 'ended'
        this.published = undefined
        return undefined
      }
      this.published = { mediaStreamTrack: { readyState: 'live' } }
      return { track: this.published }
    }
    getTrackPublication(): object | undefined {
      return this.published && { track: this.published }
    }
  }
  class Room {
    readonly handlers = new Map<string, Handler>()
    readonly localParticipant = new LocalParticipant()
    constructor(readonly options: Partial<RoomOptions>) {
      sdk.rooms.push(this)
    }
    on(event: string, fn: Handler): this {
      this.handlers.set(event, fn)
      return this
    }
  }
  return { ...actual, Room }
})

const listener = (overrides: Partial<RoomListener> = {}): RoomListener => ({
  changed: () => {},
  reconnecting: () => {},
  reconnected: () => {},
  disconnected: () => {},
  subscribed: () => {},
  unsubscribed: () => {},
  speakers: () => {},
  playback: () => {},
  screenEnded: () => {},
  ...overrides,
})

const lastRoom = () => {
  const room = sdk.rooms.at(-1)
  if (!room) throw new Error('no room')
  return room
}

describe('createLiveKitRoom', () => {
  it('reconciles subscriptions when participants or tracks go away', () => {
    const changed = vi.fn()
    createLiveKitRoom(listener({ changed }))
    const room = lastRoom()
    for (const event of [RoomEvent.ParticipantDisconnected, RoomEvent.TrackUnpublished]) {
      changed.mockClear()
      const handler = room.handlers.get(event)
      expect(handler, event).toBeDefined()
      handler?.()
      expect(changed).toHaveBeenCalledOnce()
    }
  })

  it('publishes audio with the speech preset and RED', () => {
    createLiveKitRoom(listener())
    const defaults = lastRoom().options.publishDefaults
    expect(defaults?.audioPreset).toEqual(AudioPresets.speech)
    expect(defaults?.red).toBe(true)
  })

  it('allows nobody from the start and then exactly the given identities', () => {
    const media = createLiveKitRoom(listener())
    const local = lastRoom().localParticipant
    expect(local.permissions).toEqual([[false, []]])
    media.setAllowedSubscribers(['a', 'b'])
    expect(local.permissions.at(-1)).toEqual([
      false,
      [
        { participantIdentity: 'a', allowAll: true },
        { participantIdentity: 'b', allowAll: true },
      ],
    ])
  })

  it('shares the screen at 720p and 5 fps without audio', async () => {
    const media = createLiveKitRoom(listener())
    const local = lastRoom().localParticipant
    await media.setScreenShareEnabled(true)
    expect(media.screenShared()).toBe(true)
    const [on, capture, publish] = local.screenCalls[0] ?? []
    expect(on).toBe(true)
    expect(capture).toMatchObject({
      resolution: ScreenSharePresets.h720fps5.resolution,
      contentHint: 'detail',
      audio: false,
      systemAudio: 'exclude',
      selfBrowserSurface: 'exclude',
    })
    expect(publish).toEqual({ screenShareEncoding: ScreenSharePresets.h720fps5.encoding })
    await media.setScreenShareEnabled(false)
    expect(media.screenShared()).toBe(false)
  })

  it('counts a capture waiting to be published again as shared', async () => {
    const media = createLiveKitRoom(listener())
    const local = lastRoom().localParticipant
    await media.setScreenShareEnabled(true)
    const capture = local.published
    local.published = undefined
    expect(media.screenShared()).toBe(true)
    if (capture) capture.mediaStreamTrack.readyState = 'ended'
    expect(media.screenShared()).toBe(false)
  })

  it('treats a cancelled picker as not sharing and other failures as errors', async () => {
    const media = createLiveKitRoom(listener())
    const local = lastRoom().localParticipant
    local.screenError = new DOMException('Permission denied', 'NotAllowedError')
    await media.setScreenShareEnabled(true)
    expect(media.screenShared()).toBe(false)
    local.screenError = new Error('boom')
    await expect(media.setScreenShareEnabled(true)).rejects.toBeInstanceOf(DeviceFailure)
  })

  it('reports a local screen share that ended, not one a reconnect publishes again', () => {
    const screenEnded = vi.fn()
    createLiveKitRoom(listener({ screenEnded }))
    const handler = lastRoom().handlers.get(RoomEvent.LocalTrackUnpublished) as
      | ((pub: { source: Track.Source; track?: FakeTrack }) => void)
      | undefined
    handler?.({ source: Track.Source.Camera, track: track('ended') })
    handler?.({ source: Track.Source.ScreenShare, track: track('live') })
    expect(screenEnded).not.toHaveBeenCalled()
    handler?.({ source: Track.Source.ScreenShare, track: track('ended') })
    expect(screenEnded).toHaveBeenCalledOnce()
  })
})
