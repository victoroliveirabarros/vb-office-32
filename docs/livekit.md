# Proximity audio and video with LiveKit

Audio and video travel through a self-hosted [LiveKit](https://livekit.io)
server (Apache 2.0), an SFU. vb-office-32 does not carry media: it decides
who is near whom, tells each client through the WebSocket (`nearby`) and
hands out LiveKit access tokens (`media`). The protocol is in
[`specs/phase1-protocol.md`](../specs/phase1-protocol.md).

Media is optional. Without the LiveKit variables the server sends no
`media` or `nearby` messages and everything else works the same.

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
name. It may join, publish microphone and camera, and subscribe; it may not
publish data, change its own metadata or administer the room.

Tokens last 10 minutes and the server sends a new `media` message about
every 5 minutes (it checks once a minute). A connected participant does not need them: LiveKit refreshes
its token over the signaling connection by itself. The latest token is only
used to connect again after a drop.

Who hears whom is decided by the client, which subscribes only to players
in its `nearby` set. Anyone holding a token can technically subscribe to
anyone in the room, which matches an open-plan office; private rooms come
with zones as separate LiveKit rooms. A player who closes the game keeps
its LiveKit connection until it leaves, since LiveKit renews tokens on its
own; server-side removal on leave is in the backlog.

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

- subscribing only to players in `nearby`;
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
  livekit/livekit-server:v1.13 --dev --bind 0.0.0.0 --node-ip 127.0.0.1
```

The token check against a real server runs with:

```sh
make livekit &
VB_OFFICE32_LIVEKIT_TEST_URL=http://localhost:7880 go test -run LiveKit ./internal/media
```
