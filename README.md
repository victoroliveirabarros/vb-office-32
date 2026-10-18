# vb-office-32

A small virtual office: a tile map where teammates walk around in
real time. The Go server is authoritative; the browser client lives in `web/`.

## Run

```sh
cp .env.example .env   # optional; make loads it
make run               # server on :8080
make web-dev           # Vite dev server on :5173, proxies /ws and /maps
```

Open http://localhost:5173 and pick a name.

`make` reads `.env` itself, so keep it to plain `KEY=value` lines: no quotes
and no `$`.

## Configuration

All variables are optional.

| Variable                      | Default    | Secret | Description |
|-------------------------------|------------|--------|-------------|
| `VB_OFFICE32_ADDR`            | `:8080`    | no     | Listen address. |
| `VB_OFFICE32_MAPS_DIR`        | `maps`     | no     | Directory with the `.tmj` maps. |
| `VB_OFFICE32_WEB_DIR`         | `web/dist` | no     | Built frontend. |
| `VB_OFFICE32_ALLOWED_ORIGINS` | empty      | no     | Extra WebSocket origins (`host[:port]` patterns, comma-separated). Same-origin always works, including through the Vite proxy, which keeps `Host`. |
| `VB_OFFICE32_MAX_SESSIONS`    | `200`      | no     | Concurrent WebSocket connections; above it `/ws` answers 503. |
| `VB_OFFICE32_LOG_LEVEL`       | `info`     | no     | `debug`, `info`, `warn` or `error`. |

Invalid values stop the server at boot with an error naming the variable.

## Endpoints

| Path       | Purpose |
|------------|---------|
| `/healthz` | Liveness: 200 while the process runs. |
| `/readyz`  | Readiness: 503 from the moment shutdown starts. |
| `/ws`      | WebSocket (see the protocol spec). |
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
