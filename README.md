# vb-office-32

A small virtual office: a tile map where teammates walk around in
real time. The Go server is authoritative; the browser client lives in `web/`.

## Run

```sh
cp .env.example .env   # make loads it; it sets AUTH=guest for development
make run               # server on :8080
make web-dev           # Vite dev server on :5173, proxies /ws, /maps, /auth and /api
```

Open http://localhost:5173 and pick a name. Without `.env` the server
starts in `oidc` mode and refuses to boot until the OIDC variables are set.

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

Invalid values stop the server at boot with an error naming the variable,
never its value. The OIDC provider itself is contacted on the first login,
not at boot.

## Login

With `VB_OFFICE32_AUTH=oidc` the page asks `/api/session` who is logged
in and shows an "Entrar" button otherwise. The login uses the authorization
code flow with PKCE; the server checks the ID token, that `email_verified`
is true and that the email domain is in `VB_OFFICE32_ALLOWED_DOMAINS`.
With the Google issuer the `hd` claim is also required and must be allowed,
which keeps out personal Google accounts registered with a company address.
The session is a signed `HttpOnly` cookie valid for 12 hours; open
WebSockets close with 4002 when it expires. Removing a domain from the list
revokes its sessions on their next request.

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
```

The wire protocol and map format are specified in
[`specs/phase1-protocol.md`](specs/phase1-protocol.md).

## License

Apache 2.0, see [LICENSE](LICENSE).
