# vb-office-32

A small virtual office: a tile map where teammates walk around in
real time. The Go server is authoritative; the browser client lives in `web/`.
Proximity audio and video go through a self-hosted LiveKit server: the Go
server decides who is near whom and hands out tokens (the browser side is
in progress).

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
| `VB_OFFICE32_SESSION_KEY`        | with oidc | —                             | yes    | Base64 of at least 32 random bytes (`openssl rand -base64 32`). Signs the session and login cookies; changing it logs everyone out. |
| `VB_OFFICE32_LIVEKIT_URL`        | for media | —                             | no     | LiveKit URL the browser connects to, `wss://host[:port]` without path; `ws` only for `localhost`/`127.0.0.1`. |
| `VB_OFFICE32_LIVEKIT_API_KEY`    | for media | —                             | no     | LiveKit API key (it goes in every token, so it is not secret). |
| `VB_OFFICE32_LIVEKIT_API_SECRET` | for media | —                             | yes    | LiveKit API secret; under 32 characters only logs a warning, for the development `secret`. |

Invalid values stop the server at boot with an error naming the variable,
never its value. The OIDC provider itself is contacted on the first login,
not at boot. The three LiveKit variables go together: all of them turn media
on, none turns it off, and a partial set is an error.

## Audio and video

With the LiveKit variables set, each player gets a LiveKit token right after
`welcome` (`media`) and the set of players within earshot (`nearby`): a pair
becomes near at 4 tiles and stops at more than 5. Tokens last 10 minutes and
are reissued every 5; the server never logs them. Network, cost and a
minimal LiveKit configuration are in [`docs/livekit.md`](docs/livekit.md).

```sh
make livekit     # LiveKit --dev on :7880 (devkey / secret), Linux host networking
```

`.env.example` carries the matching variables, and `make dev-oidc` also
starts LiveKit when `VB_OFFICE32_LIVEKIT_URL` is set. In guest mode run
`make livekit`, `make run` and `make web-dev`.

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

## Endpoints

| Path       | Purpose |
|------------|---------|
| `/healthz` | Liveness: 200 while the process runs. |
| `/readyz`  | Readiness: 503 from the moment shutdown starts. |
| `/ws`      | WebSocket (see the protocol spec). |
| `/api/session` | Current user: 200 `{id, name, auth}` or 401 `{auth}`. |
| `/auth/login`, `/auth/callback`, `POST /auth/logout` | OIDC login (oidc mode only). |
| `/maps/*`  | Map files. |
| `/`        | Frontend. |

On SIGTERM the server turns not ready, closes sessions with 1001
`"server restarting"` and exits within 10 s. Deployment notes are in
[`docs/deploy.md`](docs/deploy.md).

## Development

```sh
make test        # go test -race ./...
make vet
make lint        # golangci-lint, if installed
make loadbot     # 50 random-walking bots for 20s against :8080

# token check against a running LiveKit (make livekit)
VB_OFFICE32_LIVEKIT_TEST_URL=http://localhost:7880 go test -run LiveKit ./internal/media
```

The wire protocol and map format are specified in
[`specs/phase1-protocol.md`](specs/phase1-protocol.md).

## License

Apache 2.0, see [LICENSE](LICENSE).
