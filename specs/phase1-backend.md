# Fase 1 — Backend Go

Contrato: `specs/phase1-protocol.md` (obrigatório ler antes).

## Contexto

Projeto novo (diretório vazio), virtual office estilo Gather, 15 usuários iniciais. Backend Go autoritativo. Mídia (LiveKit) e SSO ficam para fases futuras — deixar fronteiras (interfaces) prontas, sem implementar.

## Complexidade

Score 11 (médio): 6+ arquivos, deps conhecidas, sem DB, sem API externa, regras de movimento, risco médio (base da arquitetura).

## User story

Como colega de time, abro o escritório no browser, vejo o mapa e os outros andando em tempo real, e meu movimento respeita paredes e móveis.

## Escopo

Dentro:
- Módulo `github.com/victoroliveirabarros/vb-office-32`, Go 1.25
- `internal/tilemap`, `internal/world`, `internal/realtime`, `internal/httpapi`, `internal/auth`
- `cmd/vb-office-32` (servidor) e `cmd/loadbot` (carga)
- `maps/office.tmj` (40×25, salas, copa, corredores, conforme contrato)
- Testes, `Makefile`, `Dockerfile`, `.golangci.yml`, CI GitHub Actions, `LICENSE` (Apache 2.0), `README.md` curto, `.gitignore`

Fora (não implementar):
- Postgres, SSO Google, LiveKit, chat, zonas, métricas Prometheus

## Padrões de código (do usuário — obrigatório)

- Go idiomático ("Go way"). Pacote por domínio, não por camada.
- **Comentários mínimos**: só onde a intenção não é óbvia. Nada de comentário narrando código. Doc comment só em API exportada não trivial.
- Interfaces pequenas, definidas no consumidor. Retornar structs concretas.
- Sem estado global, sem `init()`, wiring explícito no `main`.
- `context.Context` primeiro parâmetro onde há IO/bloqueio.
- Erros com `fmt.Errorf("...: %w", err)`, sentinels `var ErrX = errors.New(...)` quando o chamador decide algo.
- `log/slog` injetado, nunca `log` global.
- Stdlib primeiro. Dependências permitidas: `github.com/coder/websocket`, `golang.org/x/sync`. Nada além sem justificativa forte.

## Design

### `internal/tilemap`
Puro, sem goroutines.
- `Load(r io.Reader) (*Map, error)` e `LoadFile(path string) (*Map, error)`.
- `Map`: `Width`, `Height`, `Spawns []Point`; método `Blocked(p Point) bool` (fora dos limites = bloqueado). Grade interna `[]bool`.
- Valida: orthogonal, tile 32, camadas `floor`/`walls`/`spawns` presentes, ao menos 1 spawn, spawns não bloqueados.
- `Point{X, Y int}` vive aqui ou em pacote pequeno compartilhado — escolher o que evitar import cycle de forma limpa.

### `internal/world`
Máquina de estado pura. **Sem goroutines, sem canais, sem relógio real** — `now time.Time` passado como argumento.
- `Space`: dono dos jogadores. API sugerida:
  - `Join(id, name string) Player` (aplica regra de spawn/reconexão do contrato)
  - `Leave(id string)` (guarda última posição por identidade)
  - `Enqueue(id string, in Input) error` (cap 8, ignora seq antigo)
  - `Step(now time.Time) Delta` — aplica regras de movimento, retorna jogadores alterados e acks por jogador
  - `Players() []Player`
- Testes table-driven cobrindo: passo livre, parede, borda do mapa, cooldown, cap da fila, seq antigo, ack em input bloqueado, reconexão restaura posição, spawn cicla.

### `internal/realtime`
Concorrência e transporte.
- `Room`: **actor** — 1 goroutine dona de um `world.Space`. Recebe join/leave/input por canais, roda ticker 20 Hz, faz fan-out. Nenhum mutex no estado do mundo.
- `Hub`: mapa `spaceID → *Room`. Fase 1 só `"office"`. `Run(ctx)` com `errgroup`.
- `Session`: 1 conexão WS. `readLoop` (limite 4 KiB, decode/validação → room) e `writeLoop` (drena `chan []byte` buffer 64). Buffer cheio → fecha 1008 `"slow consumer"`, **nunca bloqueia o tick**. Ping do servidor a cada 20 s.
- Identidade duplicada → room fecha sessão antiga com 4001 `"replaced"`.
- `state` com `ack` é por destinatário; serializar a lista de posições uma vez por tick e montar envelope por sessão.
- Protocolo em arquivo próprio (`protocol.go`): tipos de mensagem + encode/decode JSON. Interface de codec só se cair natural; não inventar abstração sem uso.
- Origem: `websocket.AcceptOptions.OriginPatterns` vindo de config.
- Teste de integração com `httptest.Server` + 2 clientes WS: welcome, joined, move refletido no outro, colisão, left, replaced.

### `internal/auth`
- Interface no consumidor (`realtime`/`httpapi`): `Authenticate(r *http.Request) (Identity, error)`.
- `auth.Guest` implementa regra do contrato (`name` query). SSO entra na fase 2 como outra implementação.

### `internal/httpapi`
- `net/http` com padrões 1.22+ (`mux.HandleFunc("GET /healthz", ...)`).
- Rotas: `GET /healthz`, `GET /ws`, `GET /maps/` (dir de mapas), `GET /` (dir web estático, ex. `web/dist`; se não existir, 404 normal).
- Timeouts no `http.Server` (ReadHeaderTimeout etc.).

### `cmd/vb-office-32`
- Config por env com defaults:
  - `VB_OFFICE32_ADDR=:8080`
  - `VB_OFFICE32_MAPS_DIR=maps`
  - `VB_OFFICE32_WEB_DIR=web/dist`
  - `VB_OFFICE32_ALLOWED_ORIGINS=localhost:5173,127.0.0.1:5173`
  - `VB_OFFICE32_LOG_LEVEL=info`
- `slog` JSON. `signal.NotifyContext` (SIGINT/SIGTERM) + `errgroup` (http server + hub). Shutdown gracioso 10 s.
- `main` enxuto: `run(ctx, getenv, stdout) error` testável.

### `cmd/loadbot`
- Flags: `-url ws://localhost:8080/ws`, `-n 50`, `-duration 60s`, `-step 200ms`.
- Cada bot: conecta com nome único, random walk.
- Relatório final: conectados, falhas, msgs recebidas/s, latência de ack p50/p95/p99 (envio do `move` até `state` com `ack >= seq`).

### `maps/office.tmj`
- 40×25 conforme contrato. Paredes externas, 2 salas de reunião com porta (carpete), copa (madeira), área aberta com mesas, plantas. Mínimo 6 spawns na área aberta.
- Gerar via pequeno programa Go temporário ou à mão — mas o arquivo final é JSON Tiled válido versionado; não deixar gerador no repo se não agregar.

### Ferramental
- `Makefile`: `run`, `test` (`go test -race ./...`), `vet`, `lint` (golangci-lint se instalado), `build`, `loadbot`, `web-dev`, `web-build`.
- `Dockerfile` multi-stage: estágio node builda `web/` (`npm ci && npm run build`), estágio Go builda `CGO_ENABLED=0`, final `gcr.io/distroless/static-debian12:nonroot` com binário + `maps/` + `web/dist`.
- `.github/workflows/ci.yml`: job Go (vet + test -race) e job web (`npm ci`, `npm run build`, `npm test`) em `web/`.
- `.golangci.yml` v2 enxuto (errcheck, govet, staticcheck, revive, gofumpt/goimports se fizer sentido).

## Critérios de aceite

- Given servidor rodando, When cliente WS conecta com `name=ana`, Then recebe `welcome` com `selfId="guest:ana"` e ele próprio em `players`.
- Given 2 clientes, When A envia `move right` para tile livre, Then B recebe `state` com nova posição de A e A recebe `ack` = seq.
- Given parede à direita, When `move right`, Then posição não muda, `dir="right"`, ack avança.
- Given 2 `move` em < 150 ms, Then segundo só é aplicado após cooldown.
- Given A desconecta, Then B recebe `left`. When A reconecta, Then volta à última posição.
- Given mesma identidade conecta 2x, Then primeira sessão fecha com 4001.
- Given mensagem > 4 KiB, Then conexão fecha 1008.
- `go vet ./...` e `go test -race ./...` verdes.
- `loadbot -n 50 -duration 20s` contra servidor local: 0 falhas, p99 de ack < 100 ms (registrar números no relatório final).

## Entrega

Ao final, relatar: árvore de arquivos, comandos rodados e saídas resumidas (test, vet, loadbot), desvios do spec e por quê.
