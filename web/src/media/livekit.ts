import {
  AudioPresets,
  DisconnectReason,
  MediaDeviceFailure,
  Room,
  RoomEvent,
  ScreenSharePresets,
  Track,
  TrackPublication,
  VideoPresets,
} from 'livekit-client'
import type { LocalTrack, Participant, RemoteTrack, RemoteTrackPublication, ScreenShareCaptureOptions, TrackPublishOptions } from 'livekit-client'
import { DeviceFailure } from './client'
import type { DeviceError, MediaRoom, RoomListener } from './client'
import type { DisconnectKind } from './reconnect'
import type { Publication, TrackSource } from './subscriptions'

// Screens go out at 720p and 5 fps with a 360p layer (the SDK default for
// screen shares) that dynacast pauses while nobody watches it; no audio.
export const screenCapture: ScreenShareCaptureOptions = {
  resolution: ScreenSharePresets.h720fps5.resolution,
  contentHint: 'detail',
  audio: false,
  systemAudio: 'exclude',
  selfBrowserSurface: 'exclude',
  surfaceSwitching: 'include',
}

export const screenPublish: TrackPublishOptions = { screenShareEncoding: ScreenSharePresets.h720fps5.encoding }

// A subscription waiting on its publisher's permission is normal: the
// publisher allows us once the server puts us in its nearby set.
const NOT_ALLOWED_DEBUG_MS = 3_000

export function createLiveKitRoom(listener: RoomListener): MediaRoom {
  // The SDK only simulcasts captures at least 480 px wide, so the camera
  // opens at 360p with its top layer capped at the 180p bitrate; tiles pull
  // the 90p layer and dynacast pauses the top one while nobody wants it.
  // RED doubles the speech bitrate but is what survives loss on the way to
  // subscribers (docs/livekit.md).
  const room = new Room({
    adaptiveStream: true,
    dynacast: true,
    webAudioMix: true,
    publishDefaults: {
      simulcast: true,
      videoSimulcastLayers: [VideoPresets.h90],
      videoEncoding: VideoPresets.h180.encoding,
      audioPreset: AudioPresets.speech,
      dtx: true,
      red: true,
    },
    videoCaptureDefaults: { resolution: VideoPresets.h360.resolution },
  })
  // Nobody receives our tracks until the client says who is near; the SDK
  // sends this on connect, before anything is published.
  room.localParticipant.setTrackSubscriptionPermissions(false, [])
  let preview: { track: LocalTrack; el: HTMLMediaElement } | null = null
  // The SDK detaches a track before announcing it unsubscribed, so the
  // elements to remove are tracked here.
  const attached = new WeakMap<RemoteTrack, HTMLMediaElement[]>()
  const attach = (track: RemoteTrack) => {
    const el = track.attach()
    attached.set(track, [...(attached.get(track) ?? []), el])
    return el
  }

  const changed = () => listener.changed()
  const remoteChanged = (_: unknown, participant: Participant) => {
    if (participant !== room.localParticipant) changed()
  }

  room
    .on(RoomEvent.Connected, changed)
    .on(RoomEvent.ParticipantConnected, changed)
    .on(RoomEvent.ParticipantDisconnected, changed)
    .on(RoomEvent.TrackPublished, changed)
    .on(RoomEvent.TrackUnpublished, changed)
    .on(RoomEvent.TrackMuted, remoteChanged)
    .on(RoomEvent.TrackUnmuted, remoteChanged)
    .on(RoomEvent.SignalReconnecting, () => listener.reconnecting())
    .on(RoomEvent.Reconnecting, () => listener.reconnecting())
    .on(RoomEvent.Reconnected, () => listener.reconnected())
    .on(RoomEvent.Disconnected, (reason) => listener.disconnected(disconnectKind(reason)))
    .on(RoomEvent.TrackSubscribed, (track, _, participant) => {
      const source = trackSource(track.source)
      if (source) listener.subscribed({ identity: participant.identity, source, attach: () => attach(track) })
    })
    .on(RoomEvent.TrackUnsubscribed, (track, _, participant) => {
      track.detach()
      attached.get(track)?.forEach((el) => el.remove())
      attached.delete(track)
      const source = trackSource(track.source)
      if (source) listener.unsubscribed(participant.identity, source)
    })
    .on(RoomEvent.LocalTrackUnpublished, (pub) => {
      if (pub.source === Track.Source.ScreenShare) listener.screenEnded()
    })
    .on(RoomEvent.TrackSubscriptionPermissionChanged, (pub, status, participant) => {
      if (status === TrackPublication.PermissionStatus.NotAllowed) watchNotAllowed(pub, participant.identity)
    })
    .on(RoomEvent.ActiveSpeakersChanged, (speakers) => listener.speakers(speakers.map((p) => p.identity)))
    .on(RoomEvent.AudioPlaybackStatusChanged, () => listener.playback(room.canPlaybackAudio))

  const dropPreview = () => {
    if (!preview) return
    preview.track.detach(preview.el)
    preview.el.remove()
    preview = null
  }

  return {
    get canPlaybackAudio() {
      return room.canPlaybackAudio
    },
    connect: (url, token) => room.connect(url, token, { autoSubscribe: false }),
    disconnect: async () => {
      dropPreview()
      await room.disconnect()
    },
    participants: () => [...room.remoteParticipants.keys()],
    publications() {
      const pubs: Publication[] = []
      for (const participant of room.remoteParticipants.values()) {
        for (const pub of participant.trackPublications.values()) {
          const source = trackSource(pub.source)
          if (!source) continue
          pubs.push({ identity: participant.identity, sid: pub.trackSid, source, desired: pub.isDesired, muted: pub.isMuted })
        }
      }
      return pubs
    },
    setSubscribed(identity, sid, subscribed) {
      room.remoteParticipants.get(identity)?.trackPublications.get(sid)?.setSubscribed(subscribed)
    },
    setAllowedSubscribers(ids) {
      room.localParticipant.setTrackSubscriptionPermissions(
        false,
        ids.map((participantIdentity) => ({ participantIdentity, allowAll: true })),
      )
    },
    setVolume(identity, volume) {
      room.remoteParticipants.get(identity)?.setVolume(volume)
    },
    async setMicrophoneEnabled(on) {
      try {
        await room.localParticipant.setMicrophoneEnabled(on)
      } catch (err) {
        throw new DeviceFailure(deviceError(err))
      }
    },
    async setCameraEnabled(on) {
      dropPreview()
      try {
        const pub = await room.localParticipant.setCameraEnabled(on)
        if (!on || !pub?.track) return null
        preview = { track: pub.track, el: pub.track.attach() }
        return preview.el
      } catch (err) {
        throw new DeviceFailure(deviceError(err))
      }
    },
    async setScreenShareEnabled(on) {
      try {
        const pub = await room.localParticipant.setScreenShareEnabled(on, screenCapture, screenPublish)
        return on && pub !== undefined
      } catch (err) {
        // Cancelling the picker, or a system that denies capture, is no error.
        if (err instanceof DOMException && err.name === 'NotAllowedError') return false
        throw new DeviceFailure(deviceError(err))
      }
    },
    startAudio: () => room.startAudio(),
  }
}

function watchNotAllowed(pub: RemoteTrackPublication, identity: string): void {
  setTimeout(() => {
    if (pub.isDesired && pub.permissionStatus === TrackPublication.PermissionStatus.NotAllowed) {
      console.debug(`media: ${identity} has not allowed ${pub.source} for ${NOT_ALLOWED_DEBUG_MS / 1000}s`)
    }
  }, NOT_ALLOWED_DEBUG_MS)
}

// Tokens only allow these sources, so anything else is ignored.
function trackSource(source: Track.Source): TrackSource | null {
  switch (source) {
    case Track.Source.Microphone:
      return 'microphone'
    case Track.Source.Camera:
      return 'camera'
    case Track.Source.ScreenShare:
      return 'screen'
    default:
      return null
  }
}

function disconnectKind(reason?: DisconnectReason): DisconnectKind {
  switch (reason) {
    case DisconnectReason.CLIENT_INITIATED:
      return 'client'
    case DisconnectReason.DUPLICATE_IDENTITY:
      return 'duplicate'
    case DisconnectReason.PARTICIPANT_REMOVED:
      return 'removed'
    default:
      return 'other'
  }
}

function deviceError(err: unknown): DeviceError {
  switch (MediaDeviceFailure.getFailure(err)) {
    case MediaDeviceFailure.PermissionDenied:
      return 'denied'
    case MediaDeviceFailure.NotFound:
      return 'not-found'
    case MediaDeviceFailure.DeviceInUse:
      return 'in-use'
    default:
      return 'other'
  }
}
