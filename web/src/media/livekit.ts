import { AudioPresets, DisconnectReason, MediaDeviceFailure, Room, RoomEvent, Track, VideoPresets } from 'livekit-client'
import type { LocalTrack, Participant, RemoteTrack } from 'livekit-client'
import { DeviceFailure } from './client'
import type { DeviceError, MediaRoom, RoomListener } from './client'
import type { DisconnectKind } from './reconnect'
import type { Publication, TrackKind } from './subscriptions'

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
      const kind = trackKind(track.kind)
      if (kind) listener.subscribed({ identity: participant.identity, kind, attach: () => attach(track) })
    })
    .on(RoomEvent.TrackUnsubscribed, (track, _, participant) => {
      track.detach()
      attached.get(track)?.forEach((el) => el.remove())
      attached.delete(track)
      const kind = trackKind(track.kind)
      if (kind) listener.unsubscribed(participant.identity, kind)
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
          const kind = trackKind(pub.kind)
          if (!kind) continue
          pubs.push({ identity: participant.identity, sid: pub.trackSid, kind, desired: pub.isDesired, muted: pub.isMuted })
        }
      }
      return pubs
    },
    setSubscribed(identity, sid, subscribed) {
      room.remoteParticipants.get(identity)?.trackPublications.get(sid)?.setSubscribed(subscribed)
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
    startAudio: () => room.startAudio(),
  }
}

function trackKind(kind: Track.Kind): TrackKind | null {
  switch (kind) {
    case Track.Kind.Audio:
      return 'audio'
    case Track.Kind.Video:
      return 'video'
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
