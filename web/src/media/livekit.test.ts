import { AudioPresets, RoomEvent } from 'livekit-client'
import type { RoomOptions } from 'livekit-client'
import { describe, expect, it, vi } from 'vitest'
import type { RoomListener } from './client'
import { createLiveKitRoom } from './livekit'

type Handler = (...args: never[]) => unknown

const sdk = vi.hoisted(() => ({ rooms: [] as { options: Partial<RoomOptions>; handlers: Map<string, Handler> }[] }))

vi.mock('livekit-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('livekit-client')>()
  class Room {
    readonly handlers = new Map<string, Handler>()
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

const listener = (changed: () => void): RoomListener => ({
  changed,
  reconnecting: () => {},
  reconnected: () => {},
  disconnected: () => {},
  subscribed: () => {},
  unsubscribed: () => {},
  speakers: () => {},
  playback: () => {},
})

describe('createLiveKitRoom', () => {
  it('reconciles subscriptions when participants or tracks go away', () => {
    const changed = vi.fn()
    createLiveKitRoom(listener(changed))
    const room = sdk.rooms.at(-1)
    for (const event of [RoomEvent.ParticipantDisconnected, RoomEvent.TrackUnpublished]) {
      changed.mockClear()
      const handler = room?.handlers.get(event)
      expect(handler, event).toBeDefined()
      handler?.()
      expect(changed).toHaveBeenCalledOnce()
    }
  })

  it('publishes audio with the speech preset and RED', () => {
    createLiveKitRoom(listener(() => {}))
    const defaults = sdk.rooms.at(-1)?.options.publishDefaults
    expect(defaults?.audioPreset).toEqual(AudioPresets.speech)
    expect(defaults?.red).toBe(true)
  })
})
