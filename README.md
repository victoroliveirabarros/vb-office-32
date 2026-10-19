# vb-office-32

A small virtual office: a tile map where teammates walk around in
real time. The Go server is authoritative; the browser client lives in `web/`.
Proximity audio and video go through a self-hosted LiveKit server: the Go
server decides who is near whom and hands out tokens, and the browser
subscribes only to those players.

## Run

```sh
cp .env.example .env   # make loads it; it logs in through the development IdP
sed -i "s|^VB_OFFICE32_SESSION_KEY=.*|VB_OFFICE32_SESSION_KEY=$(openssl rand -base64 32)|" .env
make dev-oidc          # devidp :9000, server :8080, Vite :5173, LiveKit :7880 (Docker)
```

Open http://localhost:5173 and click "Entrar". For guest mode instead,
uncomment `VB_OFFICE32_AUTH=guest` in `.env` and run `make run` and
`make web-dev` (Vite proxies `/ws`, `/maps`, `/auth` and `/api` to :8080).
Without `.env` the server starts in `oidc` mode and refuses to boot until
the OIDC variables are set.

`make` reads `.env` itself, so keep it to plain `KEY=value` lines: no quotes
and no `$`.

## Configuration

| Variable                         | Required  | Default                       | Secret | Description |
|----------------------------------|-----------|-------------------------------|--------|-------------|
| `VB_OFFICE32_ADDR`               | no        | `:8080`                       | no     | Listen address. |
| `VB_OFFICE32_MAPS_DIR`           | no        | `maps`                        | no     | Directory with the `.tmj` maps. |
| `VB_OFFICE32_WEB_DIR`            | no        | `web/dist`                    | no     | Built frontend. |
| `VB_OFFICE32_ALLOWED_ORIGINS`    | no        | empty                         | no     | Extra WebSocket origins (`host[:port]` patterns, comma-separated). Same-origin always works, including through the Vite proxy, which keeps `Host`. |
| `VB_OFFICE32_MAX_SESSIONS`       | no        | `200`                         | no     | Concurrent WebSocket connections; above it `/ws` answers 503. |
| `VB_OFFICE32_LOG_LEVEL`          | no        | `info`                        | no     | `debug`, `info`, `warn` or `error`. |
| `VB_OFFICE32_AUTH`               | no        | `oidc`                        | no     | `oidc`, or `guest` for development (anyone joins under any name; logged as a warning). |
| `VB_OFFICE32_PUBLIC_URL`         | with oidc | —                             | no     | Browser-facing URL, `https://host[:port]` without path; `http` only for `localhost`/`127.0.0.1`. The only source of the redirect URL (`<PUBLIC_URL>/auth/callback`) and of the cookies' `Secure` flag; `X-Forwarded-*` is ignored. |
| `VB_OFFICE32_OIDC_ISSUER`        | no        | `https://accounts.google.com` | no     | OpenID Connect issuer. Any provider with discovery works. |
| `VB_OFFICE32_OIDC_CLIENT_ID`     | with oidc | —                             | no     | OAuth client ID. |
| `VB_OFFICE32_OIDC_CLIENT_SECRET` | with oidc | —                             | yes    | OAuth client secret, sent with HTTP Basic (`client_secret_basic`). |
| `VB_OFFICE32_ALLOWED_DOMAINS`    | with oidc | —                             | no     | Comma-separated email domains allowed in, e.g. `example.com,example.org`. |
| `VB_OFFICE32_SESSION_KEY`        | with oidc | —                             | yes    | Base64 of at least 32 random bytes (`openssl rand -base64 32`). Signs the session and login cookies; changing it alone logs everyone out. |
| `VB_OFFICE32_SESSION_KEY_PREVIOUS` | no      | —                             | yes    | The key before a rotation, same format. Cookies it signed are still accepted; new ones always use `VB_OFFICE32_SESSION_KEY`. See [rotation](docs/deploy.md#rotating-the-session-key). |
| `VB_OFFICE32_LIVEKIT_URL`        | for media | —                             | no     | LiveKit URL the browser connects to, `wss://host[:port]` without path; `ws` only for `localhost`/`127.0.0.1`. |
| `VB_OFFICE32_LIVEKIT_API_KEY`    | for media | —                             | no     | LiveKit API key (it goes in every token, so it is not secret). |
| `VB_OFFICE32_LIVEKIT_API_SECRET` | for media | —                             | yes    | LiveKit API secret; under 32 characters only logs a warning, for the development `secret`. |

Invalid values stop the server at boot with an error naming the variable,
never its value. The OIDC provider itself is contacted on the first login,
not at boot. The three LiveKit variables go together: all of them turn media
on, none turns it off, and a partial set is an error.

## Audio and video

With the LiveKit variables set, each player gets a LiveKit token right after
`welcome` (`media`). Media or not, the server sends each player the set of
players within earshot (`nearby`): a pair becomes near at 4 tiles and stops
at more than 5. The meeting room and the private rooms are zones of the map
(`zones` layer): inside one, earshot is everyone in the same zone at any
distance and nobody outside, not even at the door, and each player is told
its own zone (`zone`) at join and whenever it crosses a border. Tokens last
10 minutes and are reissued about every 5 (the server checks once a
minute); the server never logs them. A player whose WebSocket stays closed for 30 seconds is
removed from the LiveKit room through its API, since LiveKit would otherwise
keep renewing that connection; reconnecting within the 30 seconds keeps the
call. Anyone who joins the LiveKit room without a WebSocket here is removed
as soon as LiveKit reports it (webhook on `POST /livekit/webhook`), and once a
minute the server also lists the room as a safety net. Network, cost and a
minimal LiveKit configuration are in [`docs/livekit.md`](docs/livekit.md).

In the browser the LiveKit SDK loads only when the first `media` arrives.
The microphone turns on at join (a mute is remembered in `localStorage`),
the camera starts off, and the buttons at the bottom toggle both. Everyone
in `nearby` is heard, louder when closer (full volume up to 1 tile, down to
20% at 4); the cameras of the 8 closest show as small tiles at the top, and
a ring marks who is speaking. When the browser blocks autoplay an "Ativar
áudio" button appears.

```sh
make livekit     # LiveKit --dev on :7880 (devkey / secret), Linux host networking
```

`.env.example` carries the matching variables, and `make dev-oidc` also
starts LiveKit when `VB_OFFICE32_LIVEKIT_URL` is `ws://localhost` or
`ws://127.0.0.1`. In guest mode run
`make livekit`, `make run` and `make web-dev`.

## Chat

Players chat with everyone in the space, with whoever is `nearby` at the
moment of sending (inside a zone, only those in it), or directly with one
player who is online (otherwise the sender gets `offline`; nothing is
queued). The server cleans the text
(invalid UTF-8, control and bidi/format characters, blank letters such as
the Hangul filler, trailing spaces, runs of blank lines; emoji sequences and
the Persian ZWNJ survive), refuses it when empty or over 500 characters or
20 lines instead of truncating, and allows each identity, across all its
connections, 5 chats in a row and then one every 2 seconds, and each space
40 `everyone` chats in a row and then 20 per second from all senders
together (`rate_limited`, without closing the connection). The sender's name comes
from its session. The last 100 `everyone` messages are kept in memory and
sent to whoever joins; `nearby` and direct messages are never kept, and
nothing survives a restart. Message text, recipients and client ids never
reach the logs. Rules and formats are in the
[protocol spec](specs/phase1-protocol.md#chat).

In the browser each zone has its own carpet and a sign with its name on the
wall above it, the room you are in gets a thin outline, and a strip at the
top left shows it ("Ringue de box — privada"). Inside a zone the
"Perto" tab takes the room's name and warns that only the room sees it; the
list of people marks who is in your room ("na sala"), near you ("perto") or
in another room, read from positions and the public map. Clicking someone's
avatar or name opens a direct conversation; its tab closes with ×, the
Delete key or "Fechar conversa". Names used by more than one person get a
short tag derived from their id (`Ana #k3f9`) in the list, the chat and over
the avatars.

## Login

With `VB_OFFICE32_AUTH=oidc` the page asks `/api/session` who is logged
in and shows an "Entrar" button otherwise. The login uses the authorization
code flow with PKCE; the server checks the ID token, that `email_verified`
is true and that the email domain is in `VB_OFFICE32_ALLOWED_DOMAINS`.
With the Google issuer the `hd` claim is also required and must be allowed,
which keeps out personal Google accounts registered with a company address.
The session is a signed `HttpOnly` cookie valid for 12 hours that keeps the
subject, the display name and the email domain, not the address; open
WebSockets close with 4002 when it expires. Removing a domain from the list
revokes its sessions on their next request.

## Local login with the development IdP

`cmd/devidp` is a stdlib-only OpenID provider for testing the whole login
in the browser without Google. It listens only on loopback
(`127.0.0.1:9000`), generates its signing key at boot and signs in whoever
fills its form, so it is never part of the image.

```sh
make devidp      # terminal 1
make run         # terminal 2, with the OIDC block of .env.example
make web-dev     # terminal 3
# or all three at once: make dev-oidc
```

"Entrar" leads to the devidp page, which offers preset users (Ana and Bruno
are accepted with `ALLOWED_DOMAINS=example.com`; `eve@outsider.test` and an
unverified email are refused), a form for any name, email,
`email_verified` and `hd`, and a button that answers `access_denied`.
Its defaults match `.env.example`: issuer `http://localhost:9000`, client
`dev-client`/`dev-secret` and redirect `http://localhost:5173/auth/callback`.
Change them with flags (`go run ./cmd/devidp -h`), `DEVIDP_FLAGS` or the
`DEVIDP_*` variables, keeping the server's variables in step.

## Security headers

Every response carries a `Content-Security-Policy` that allows scripts,
styles, media and fonts from the page's own origin only (no inline code;
audio and video play from `MediaStream`s), images also from `data:`/`blob:`,
connections to the page's origin and to the LiveKit URL (`ws(s)://` and
`http(s)://`), forms to the page's origin only (login is a link, not a
form), and no framing. They also get
`X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
`Permissions-Policy` (camera and microphone for the page only, no
geolocation or screen capture) and `Cross-Origin-Opener-Policy:
same-origin`; `Strict-Transport-Security: max-age=31536000` is added when
`VB_OFFICE32_PUBLIC_URL` is https, which only exists in oidc mode, so guest
mode never sends HSTS.

The Vite dev server does not send these headers: check CSP changes against
the build served by the Go server (`make web-build` and `make run`, then
open http://localhost:8080). In dev, Vite answers only for `localhost` and
`127.0.0.1` and refuses `/ws` upgrades for any other `Host`, which blocks
DNS rebinding through its proxy. The Go server reached directly (port 8080,
without Vite) does not check `Host`: in guest mode a rebound page sees
matching `Host` and `Origin` and can open `/ws` under any name, which is
harmless because guest mode lets anyone do that anyway (development only).
In oidc mode rebinding gains nothing, since the session cookie belongs to
the real host name and is not sent to the rebound one.

## Endpoints

| Path       | Purpose |
|------------|---------|
| `/healthz` | Liveness: 200 while the process runs. |
| `/readyz`  | Readiness: 503 from the moment shutdown starts. |
| `/ws`      | WebSocket (see the protocol spec). |
| `/api/session` | Current user: 200 `{id, name, auth}` or 401 `{auth}`. |
| `/auth/login`, `/auth/callback`, `POST /auth/logout` | OIDC login (oidc mode only). |
| `/maps/*`  | Map files. |
| `POST /livekit/webhook` | LiveKit webhooks, signed with the API secret (with media only). |
| `/`        | Frontend. |

On SIGTERM the server turns not ready, closes sessions with 1001
`"server restarting"` and exits within 10 s. Deployment notes are in
[`docs/deploy.md`](docs/deploy.md).

## Map and art

`maps/office.tmj` and its tile atlas `web/public/game/office-tiles.png` are
generated; do not edit them by hand. `tools/officeart` reads the floor plan
in `tools/officeart/office.txt` (three 50×25 character grids: `floor`,
`solid` for everything that blocks movement, and `decor` for art without
collision, such as chairs, monitors and pictures), takes only the tiles it
uses from the Kenney sheets in `art/kenney/` and the sprites drawn as text in
`art/custom/`, scales them 2× with nearest neighbour to the 32 px tile and
repeats each tile's edge pixels around it so that none bleeds into the next.

The office is an open room with 15 workstations in three desk islands with
seats on both sides, each station two tiles wide with a monitor, keyboard and
something beside it, office chairs, a lounge and a table for six. Above it sit the meeting room (`reuniao`, a `meeting` zone
where screens can be shared) and the kitchen, which opens wide onto the
office and is no zone, so talk there goes by distance as in the office; on
its left the private room for six (`privada`) and on its right the boxing
ring (`ringue`), both `private` zones. Each room has one door to the office. Tiles marked `~` are outside
the building: they block and are drawn see-through, so the page background
shows around the office's outline.

```sh
make art                                     # rewrites the map and the atlas
make art ART_FLAGS="-sheet /tmp/officeart"   # also writes index.png (every tile with its gid and source) and map.png
```

It refuses to change which tiles block movement compared with the current
map unless run with `-allow-mask-change`, and `go test ./tools/officeart`
fails while the committed files differ from what it generates. The art is
CC0; sources, versions and checksums are in [CREDITS.md](CREDITS.md).

## Development

```sh
make test        # go test -race ./...
make vet
make lint        # golangci-lint, if installed
make loadbot     # 50 random-walking bots for 20s against :8080
make loadbot LOADBOT_FLAGS="-n 50 -duration 20s -chat"   # bots also chat, reports echo latency

# token, removal and reconciliation checks against a running LiveKit (make livekit)
VB_OFFICE32_LIVEKIT_TEST_URL=http://localhost:7880 go test -run LiveKit ./internal/media ./internal/realtime
```

The wire protocol, zones and map format are specified in
[`specs/phase1-protocol.md`](specs/phase1-protocol.md).

## License

Apache 2.0, see [LICENSE](LICENSE).
