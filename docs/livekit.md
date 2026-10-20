# Proximity audio and video with LiveKit

Audio and video travel through a self-hosted [LiveKit](https://livekit.io)
server (Apache 2.0), an SFU. vb-office-32 does not carry media: it decides
who is near whom, tells each client through the WebSocket (`nearby`) and
hands out LiveKit access tokens (`media`). The protocol is in
[`specs/phase1-protocol.md`](../specs/phase1-protocol.md).

Media is optional. Without the LiveKit variables the server sends no
`media` messages and everything else works the same; `nearby` still goes
out, since the chat uses it too.

## Configuration

| Variable | Example | Secret |
|---|---|---|
| `VB_OFFICE32_LIVEKIT_URL` | `wss://media.example.com` | no |
| `VB_OFFICE32_LIVEKIT_API_KEY` | `office` | no (it travels in every token) |
| `VB_OFFICE32_LIVEKIT_API_SECRET` | 32+ random characters | yes |

- Set all three or none; a partial set stops the server at boot with an
  error naming the missing variable.
- The URL is what browsers connect to: `wss://host[:port]` without path or
  query, or `ws://` on `localhost`/`127.0.0.1` for development.
- The key and secret are the pair configured in LiveKit (`keys` in
  `livekit.yaml` or `LIVEKIT_KEYS`). A secret shorter than 32 characters is
  accepted with a warning so the development `secret` works; use
  `openssl rand -base64 32` in production.

## Tokens

Each WebSocket session gets a token for the LiveKit room named after the
space (`office`), with the player ID as identity and the display name as
name. It may join, publish microphone, camera and screen (no screen audio),
and subscribe; it may not publish data, change its own metadata or
administer the room. It never carries `recorder`, which ignores the
publishers' permissions below.

Tokens last 10 minutes and the server sends a new `media` message about
every 5 minutes (it checks once a minute). A connected participant does not need them: LiveKit refreshes
its token over the signaling connection by itself. The latest token is only
used to connect again after a drop.

## Who receives whom

The whole office is one LiveKit room. What keeps a meeting room private is
each publisher's **subscription permissions**: every client tells LiveKit
that only the players in its `nearby` set may receive its tracks
(`setTrackSubscriptionPermissions(false, [{participantIdentity, allowAll:
true}, …])`), and the SFU enforces it. Inside a zone `nearby` is everyone
in the same zone and nobody else (`specs/phase1-protocol.md`), so whoever
stands outside, even at the door, cannot receive anything from inside.

- **Order.** Nobody is allowed from the moment the client creates the
  room; the SDK sends that on connect, before anything is published. Once
  `connect()` resolves the client sends the current set and only then
  opens the microphone and camera. The list is sent again on every
  `nearby` that changes it, and emptied on `welcome` and whenever the game
  socket is not open (the server no longer places us).
- **In the SFU.** A subscription without permission is answered with
  `not_allowed`; LiveKit keeps the request and completes it as soon as the
  publisher allows it. Revoking closes the forwarding at once. `allowAll`
  per identity covers tracks published later (a screen share), and the
  permissions survive a resume and are sent again after a restart. Speaking
  indicators only reach those subscribed. `not_allowed` is the normal
  state for someone not yet near, not an error (the client logs it at debug
  level when it lasts more than 3 seconds).
- **Revocation needs the publisher's signaling.** Only the publisher can
  change its permissions. While its signaling connection is reconnecting
  (`SignalReconnecting`, a resume) the SDK queues the update and media
  already forwarded keeps flowing until the connection is back; a full
  reconnect sends the permissions again before republishing anything.
- **The edge on entering.** Permissions follow `nearby`, so whoever was
  near someone in the open area keeps receiving them for one permission
  round trip after they step into a room: about 220 to 270 ms from their
  `zone` message to the last bytes, measured with a modified client that
  keeps subscribing. What leaks is the first quarter second said inside the
  door; that limit is accepted.
- **Modified clients.** A subscriber that asks for everything still sees
  who is in the room and what they publish, but gets no media and no
  speaking indicator. A modified publisher can only expose itself. Who is
  in which room is public anyway: positions travel to everyone and the map
  is public.
- **Discarded:** one LiveKit room per zone (no `MoveParticipant` in the
  open-source server, so every door would cost a reconnection of 0.5 to
  1.5 s, plus N rooms for the webhook and the reconciliation), and
  `UpdateSubscriptions`/`UpdateParticipant`, which have no per-pair rule.

Measured with `web/e2e/intruder.mjs` (below) against LiveKit v1.13.10 and
Chrome headless, 13 runs on one machine. Ana sits inside a meeting room with
microphone, camera and screen; Eve is a modified client with a valid
session that subscribes to everything (`autoSubscribe: true`):

| Step | Result |
|---|---|
| Eve at the door (outside the zone, 3 tiles from Ana) | all 3 tracks `not_allowed`, no `TrackSubscribed`, 0 bytes received |
| Eve steps in: `zone` message → `TrackSubscribed` | 81–210 ms (median 86) |
| Eve steps in: `zone` message → first media bytes | 63–189 ms (median 72; sampled every 50 ms) |
| Eve steps out: `zone` message → last media bytes | 185–232 ms (median 206) |
| Eve steps out: `zone` message → `TrackUnsubscribed` | 278–482 ms (median 283) |
| An honest client steps in: `zone` → audio / screen attached | 101–335 ms / 106–354 ms (median 107 / 112) |
| Ana walks out of the room: `zone` → her share stopped | 79–198 ms (median 85) |

Entering and leaving both happen on the server tick that moves the player,
which sends `zone` and `nearby` together; the rest is the publisher's
permission update reaching LiveKit. The SDK reports the unsubscription
about 100 ms after the media has already stopped.

## Screen sharing

- Offered inside any zone (`meeting`, `private` or `desk`), with the call
  connected, and not while someone else in the zone is sharing. Leaving the
  zone stops the share, and so does stepping straight into another one
  (desks of a row touch: x 17 → 18 goes from `mesa-01` to `mesa-02`), since
  the client remembers the zone the share started in; so do the browser's
  own "stop sharing" button and the room dropping. Cancelling the picker is
  not an error. A share never restarts by itself, since the picker needs a
  click.
- **Leaving with a screen on air.** Stopping a share is asynchronous
  (unpublishing takes a negotiation, and the picker or the publish may still
  be pending at the door), while the new place's `nearby` arrives right
  after `zone`. So away from the share's zone (outside every zone or in
  another one), while the screen is live or a share call is pending, the
  client only ever narrows its permissions (it sends the intersection of the
  last list and the new `nearby`) and widens them to the whole `nearby` once
  the screen is off the air. A share whose picker resolves after leaving is
  unpublished first. Per-track permissions (leaving the screen's track out)
  were discarded: every publish, and every full reconnect, changes the track
  IDs, so the list would have to follow each one, and a gap would block the
  microphone.
- **Reconnects.** A full reconnect unpublishes and republishes every track,
  the screen included, without stopping its capture; only a capture that
  really ended (the browser's button, our own stop) ends the share. Once
  reconnected the client asks the room whether the screen is on air,
  follows it, and stops it if it should not be (away from its zone or
  turned off meanwhile).
- **Two shares at once.** Two people may click within the same round trip,
  before either sees the other's screen. Whoever has the larger identity
  stops theirs and is told that someone in the zone started first.
- Published at 720p and 5 fps (`ScreenSharePresets.h720fps5`, capped at
  800 kbit/s, `contentHint: detail`) with a 360p layer at up to
  200 kbit/s, the SDK default for screens; dynacast pauses whichever layer
  nobody pulls. No audio.
- Each client watches at most one screen: only inside a zone, only from
  someone in its `nearby` set (the same zone), keeping the current one while
  it lasts and otherwise the smallest identity. It shows on a large stage
  over the map.
- The page sends `Permissions-Policy: display-capture=(self)`;
  `display-capture=()` would block `getDisplayMedia`.
- LiveKit does not stop a modified client from publishing a screen outside
  a zone. The server tolerates it: honest clients never subscribe to a
  screen outside a zone, so it reaches nobody else and costs no egress.
  Removing such tracks (webhook `track_published` + `UpdateParticipant`) is
  in the backlog.

## Removal

LiveKit renews the token of a connected participant by itself, so closing
the game, an expired session (4002) or a removed domain would not end the
call of a modified client. When a player's WebSocket closes, vb-office-32
waits 30 seconds and, if the same identity has not connected again, calls
`POST <LiveKit URL over http(s)>/twirp/livekit.RoomService/RemoveParticipant`
with a one-minute admin token (`roomAdmin` for that room only, no
`roomJoin`). A participant that is already gone (404 `not_found`) counts as
removed; network errors and 5xx are retried once and then logged as a
warning, never with the token. A replaced session (4001) keeps its identity
connected, so nothing is removed, and a server shutdown cancels pending
removals because clients reconnect to the next process.

A removed client still holds a valid token: the last one we sent (up to 10
minutes), or the one LiveKit hands out on every join and renews while
connected. Two mechanisms keep a modified client out:

- **Webhook.** LiveKit posts `participant_joined` to
  `POST /livekit/webhook` when a participant becomes active (media
  connected). If that identity has no WebSocket here and is not within its
  30 seconds, vb-office-32 removes it at once, whether or not we ever issued
  it. The request must carry `Content-Type: application/webhook+json` and an
  `Authorization` header with a JWT that LiveKit signs (HS256 with the API
  secret, `iss` = API key, `sha256` = base64 of the body's SHA-256, valid
  for 5 minutes; 30 seconds of clock skew are tolerated). Anything else gets
  401 or 400; bodies are limited to 1 MiB and the token is never logged.
  Measured on v1.13 with a browser client: removal 2 ms after LiveKit
  marks the participant active, about 40 ms after its join, before the SDK
  finishes connecting; joining again with the same token is removed the
  same way every time.
- **Reconciliation.** Once a minute, on the same check that renews grants,
  vb-office-32 lists the room (`ListParticipants`, same admin token) and
  removes every identity without a WebSocket and outside its 30 seconds.
  It catches what the webhook cannot: a lost webhook, and a client that
  only opens the signaling connection without ever connecting media
  (LiveKit sends no `participant_joined` for it, and drops it by itself
  after 60 seconds). Only one list is in flight at a time; a failed list is
  logged as a warning and the next check tries again. The decision uses the
  players connected when the list comes back, not when it was asked for.

What remains: LiveKit sends a fresh 10-minute token 1 ms after every join,
before the participant is active, so a modified client can keep joining
forever; each attempt lasts about 40 ms with the webhook (up to a minute
without it) and gets the list of who is in the room, but no call. Revoking
the permissions with `UpdateParticipant` before removing would not help,
since the token is already out. Rotating the API secret is the only full
revocation.

A removal already sent can still land on a player whose WebSocket came back
meanwhile. When a removal finishes and that identity is connected, the
server sends it a new `media` message at once. The honest client waits for
the next `media` after a removal and, when the removal arrives less than
10 seconds after a grant (the server never removes anyone that recent),
connects again with that grant right away, so the call comes back within
seconds.

The room service is reached through the same TLS proxy as signaling, so
vb-office-32 needs egress to the LiveKit URL. In the other direction LiveKit needs
to reach vb-office-32's `/livekit/webhook`, through the public URL or an
internal one. The page's CSP allows that URL
in `connect-src` (`ws(s)://` for signaling and `http(s)://` for the SDK's
connection checks).

## Network

LiveKit needs a stable public IP that browsers reach directly:

| Port | Protocol | Purpose |
|---|---|---|
| 7880 | TCP | Signaling (WebSocket) and HTTP API. Only the TLS proxy may reach it. |
| 7882 | UDP | Media for every participant, multiplexed on one port. |
| 7881 | TCP | Media fallback (ICE over TCP) for networks that block UDP. |
| 443 | TCP | Optional TURN/TLS, for networks that only allow HTTPS. |

- **Host networking and a stable public IP.** ICE candidates carry the
  server's own address and port; NAT layers that rewrite ports break them.
  Run LiveKit with host networking on an instance with a static public IP
  and set `rtc.use_external_ip: true` (it discovers the IP through STUN) or
  `rtc.node_ip` explicitly.
- **Not behind an ordinary load balancer.** Media is UDP between the browser
  and the exact node that holds the session, so an HTTP load balancer cannot
  carry it, and spreading UDP across nodes breaks sessions. Open 7882/udp
  and 7881/tcp straight to the instance. Only the signaling port goes
  through a proxy.
- **Signaling through a TLS proxy.** Pages served over https can only open
  `wss://`. Terminate TLS for the media host name at a reverse proxy (or a
  TLS load balancer) and forward to 7880 with WebSocket upgrades allowed and
  an idle timeout of a few minutes.
- **Close 7880 to the internet.** Host networking exposes every port
  LiveKit binds, so the firewall or security group must let only the TLS
  proxy reach 7880 (and keep the Prometheus port private); otherwise the
  signaling and HTTP API are reachable in plain text, around the proxy.
- **Do not log query strings at the proxy.** The SDK sends the access token
  in the query (`/rtc?access_token=…`), so access logs that keep the full
  URL store valid tokens. Log the path only.
- **Browsers may print the token.** When the signaling WebSocket fails,
  Chrome writes the full URL, token included, in the console (`WebSocket
  connection to 'wss://…/rtc/v1?access_token=…' failed`). The SDK redacts
  its own logs, but browsers cannot send headers on a WebSocket, so the
  token has to be in the URL and the browser's message is out of the app's
  control. Console captures and error reports may therefore hold a token;
  the 10-minute TTL keeps that window short.
- **TURN/TLS on 443** helps clients behind strict firewalls. It needs its
  own host name and certificate (`turn.domain`, `turn.tls_port`). The media
  goes through the server either way, so it adds little egress; the cost is
  mostly CPU for TLS and relaying. Leave it off until someone needs it.
- One node is enough for one office; a cluster needs Redis and is out of
  scope here.

## Example `livekit.yaml`

```yaml
port: 7880
logging:
  level: info
rtc:
  tcp_port: 7881
  udp_port: 7882        # a single port: UDP mux
  use_external_ip: true # or node_ip: <public IP>
room:
  auto_create: true
  empty_timeout: 300
prometheus:
  port: 6789            # keep it private
webhook:
  api_key: <api key>    # signs the webhooks with its secret
  urls:
    - https://office.example.com/livekit/webhook
# keys come from the environment, not from this file:
#   LIVEKIT_KEYS="<api key>: <api secret>"
```

```sh
docker run -d --name livekit --network host --restart unless-stopped \
  -v $PWD/livekit.yaml:/livekit.yaml \
  -e LIVEKIT_KEYS="<api key>: <api secret>" \
  livekit/livekit-server:v1.13 --config /livekit.yaml
```

Deliver the secret from a secret store to both LiveKit and vb-office-32.
LiveKit reads `LIVEKIT_KEYS` only at boot, so rotating the secret means
restarting both. On a single node the LiveKit restart drops every media
connection; clients connect again with the token from the next `media`
message, which the restarted vb-office-32 signs with the new secret.

## Cost

Egress from the SFU dominates. Every subscriber receives each publisher it
subscribes to, so traffic grows with the size of each conversation, not
with the size of the office. The client keeps it down by:

- subscribing only to players in `nearby` (and publishers allowing only
  them, so a modified client cannot pull more);
- leaving the camera off by default and subscribing to the cameras of the
  8 closest players only, keeping a camera until someone else is more than
  a tile closer so the 8th place does not flip back and forth;
- publishing audio with the `speech` preset (Opus capped at 24 kbit/s),
  DTX (almost nothing during silence) and RED, which repeats the previous
  frame in each packet so a lost packet costs no audio;
- sending small video with simulcast: the camera opens at 360p (the SDK
  only simulcasts captures at least 480 px wide) with a 90p layer, which is
  what the 160x90 tiles pull, and a top layer capped at the 180p bitrate
  (160 kbit/s);
- adaptive stream (no video for hidden or tiny tiles) and dynacast (the
  publisher stops encoding layers nobody watches).

Measured per audio stream on LiveKit v1.13 with Chrome (RTP payload; RTP
headers add about 5 kbit/s and IP/UDP about 11 more at 50 packets/s):

| Signal | `music` + RED (before) | `speech` + RED (used) | `speech`, no RED |
|---|---|---|---|
| Continuous speech-like audio | 88 kbit/s | 45 kbit/s | 22 kbit/s |
| Chrome's fake device (beeps) | 77 kbit/s | 40 kbit/s | 19 kbit/s |
| Talking half of the time | — | 25 kbit/s | 12 kbit/s |
| Audio concealed at 3% loss | — | 0% | 3.4% |
| Audio concealed at 10% loss | — | 1.2% | 9.3% |

Loss was applied between LiveKit and the subscribers. Without RED nothing
covers it: Opus in-band FEC only kicks in when the publisher sees loss, and
the publisher's own link was clean. RED only doubles the bitrate while
someone speaks (DTX sends almost nothing in silence), so it stays on.

Small video adds about 90 kbit/s per subscribed camera (160 kbit/s at
most).

A screen share costs about 0.2 to 0.8 Mbit/s per viewer: the 720p layer
the stage pulls is capped at 800 kbit/s at 5 fps, and a mostly static
screen sends far less (a headless Chrome's synthetic desktop measured
130 kbit/s at 1280x720 and 5 fps). With one screen per zone and viewers
limited to the zone, a meeting of N costs at most N − 1 times that.

Inside a zone everyone in the room plays at full volume; distance only
lowers the volume in the open area.

## Metrics to watch

LiveKit exposes Prometheus metrics on `prometheus.port`. Useful signals:

- bytes and packets sent (egress) and received;
- participants and rooms;
- packet loss, NACKs and jitter;
- share of connections on TCP or TURN instead of UDP (a rising share points
  to firewall issues and costs more);
- CPU and network of the instance.

## Local development

```sh
make livekit   # LiveKit --dev on :7880 with key devkey and secret secret
```

`make livekit` also passes `LIVEKIT_CONFIG` (configuration given as YAML in
an environment variable) so LiveKit posts webhooks to
`http://127.0.0.1:8080/livekit/webhook`, the server of `make run`. Point it
elsewhere with `make livekit LIVEKIT_WEBHOOK=http://127.0.0.1:9090/livekit/webhook`.
While the server is down LiveKit logs failed webhooks; the periodic list
still removes intruders.

`.env.example` has the matching block (`ws://localhost:7880`, `devkey`,
`secret`), and `make dev-oidc` starts LiveKit too when
`VB_OFFICE32_LIVEKIT_URL` points at `ws://localhost` or `ws://127.0.0.1`. In guest mode run `make livekit`,
`make run` and `make web-dev`. The browser connects to LiveKit directly;
Vite does not proxy it.

Two people on one machine: open two windows with different guest names (or
a normal and a private window in oidc mode). Chrome can stand in fake
devices with `--use-fake-device-for-media-stream
--use-fake-ui-for-media-stream`. Walk within 4 tiles to hear each other and
more than 5 apart to stop; turn a camera on to see its tile on the other
side.

`make livekit` passes `--bind 127.0.0.1` because `--dev` alone also binds
`::1` and fails on hosts without IPv6 loopback. It uses host networking,
which works on Linux. Elsewhere
publish the ports and give LiveKit an address the browser can reach:

```sh
docker run --rm -p 7880:7880 -p 7881:7881 -p 7882:7882/udp \
  -e LIVEKIT_CONFIG="webhook: {api_key: devkey, urls: [http://host.docker.internal:8080/livekit/webhook]}" \
  livekit/livekit-server:v1.13 --dev --bind 0.0.0.0 --node-ip 127.0.0.1
```

The privacy and screen-sharing measurements above come from a
development-only harness that is not part of the build: `web/e2e/intruder.html`
opens one participant per tab (`role=honest` runs the real media client,
`role=intruder` subscribes to everything) and `web/e2e/intruder.mjs` drives
headless Chrome through the DevTools protocol, with fake devices and an
automatically picked screen. Build it for the Go server to serve, start
LiveKit and the server, then run it:

```sh
cd web && npx vite build --config e2e/vite.config.ts   # into web/e2e/dist
make livekit &
VB_OFFICE32_AUTH=guest VB_OFFICE32_WEB_DIR=web/e2e/dist \
  VB_OFFICE32_LIVEKIT_URL=ws://localhost:7880 VB_OFFICE32_LIVEKIT_API_KEY=devkey \
  VB_OFFICE32_LIVEKIT_API_SECRET=secret go run ./cmd/vb-office-32 &
cd web && node e2e/intruder.mjs http://localhost:8080
```

It prints the checks and latencies as JSON and exits non-zero when a check
fails. With `make web-dev` running, `node e2e/intruder.mjs
http://localhost:5173` uses Vite instead of a build (without the server's
headers).

The token, removal and reconciliation checks against a real server run
with:

```sh
make livekit &
VB_OFFICE32_LIVEKIT_TEST_URL=http://localhost:7880 go test -run LiveKit ./internal/media ./internal/realtime
```
