# vb-office-32

A small virtual office: a tile map where teammates walk around in
real time. The Go server is authoritative; the browser client lives in `web/`.

## Run

```sh
make run         # server on :8080
make web-dev     # Vite dev server on :5173, proxies /ws and /maps
```

Open http://localhost:5173 and pick a name.

## Configuration

| Variable                      | Default                          |
|-------------------------------|----------------------------------|
| `VB_OFFICE32_ADDR`            | `:8080`                          |
| `VB_OFFICE32_MAPS_DIR`        | `maps`                           |
| `VB_OFFICE32_WEB_DIR`         | `web/dist`                       |
| `VB_OFFICE32_ALLOWED_ORIGINS` | `localhost:5173,127.0.0.1:5173`  |
| `VB_OFFICE32_LOG_LEVEL`       | `info`                           |

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
