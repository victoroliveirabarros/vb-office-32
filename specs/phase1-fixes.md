# Fase 1 — Correções do QA + rename

Base: implementação atual da fase 1 + specs `phase1-protocol.md`, `phase1-backend.md`, `phase1-web.md`. Manter os mesmos padrões de código (Go idiomático, comentários mínimos, sem `any`).

## A. Rename do projeto: `office32` → `vb-office-32`

- Módulo Go: `github.com/victoroliveirabarros/vb-office-32` (atualizar todos os imports).
- `cmd/office32` → `cmd/vb-office-32`; binário `vb-office-32`.
- Envs: prefixo `OFFICE32_` → `VB_OFFICE32_` (código, testes, README, Dockerfile, Makefile, CI, specs).
- `web/package.json` name `vb-office-32`; `<title>` e textos visíveis com o nome do produto.
- Imagem/target Docker, README, LICENSE (se citar nome), `.github/workflows/ci.yml`, specs (`specs/*.md`).
- **Não** renomear o diretório raiz no disco.
- Ao final: `grep -rni "office32" --exclude-dir=node_modules --exclude-dir=.git .` só pode retornar ocorrências de `vb-office-32`/`VB_OFFICE32_`/`vb_office32`.

## B. Correções

### B1 (importante) — Transbordo da fila deixa predição adiantada
- `MaxPendingInputs = 8` vira constante explícita do contrato (`specs/phase1-protocol.md`) e no código dos dois lados.
- Cliente (`web/src/scenes/OfficeScene.ts` + `game/prediction.ts`): não enviar nem prever quando `pendingCount >= 8` (backpressure). Teste Vitest cobrindo: rajada com 10 tentativas → só 8 pendentes, nenhuma divergência após acks.
- Servidor: manter descarte, sem mudança de semântica de ack.

### B2 — Nome não propaga em replaced
- `internal/realtime/room.go`: em replaced, se o nome mudou, broadcast `joined` com Player atualizado (cliente já faz upsert). Teste de integração.

### B3 — Motivo de fechamento não logado
- `internal/realtime/session.go`: ao fim de `run`, logar motivo (`slow consumer`, `ping timeout`, `replaced`, `protocol error`, normal) em nível adequado (Warn para anomalias, Info/Debug para normal), com identidade.

### B4 — Listagem de diretório
- `internal/httpapi`: não listar diretórios em `/maps/` e static (404 para paths de diretório, exceto `/` que serve `index.html`). Teste.

### B5 — Cadência do cooldown perde ticks com atraso
- `internal/world/world.go`: ancorar próximo passo sem acumular atraso: `nextStep = max(nextStep, now - stepSlack) + StepCooldown` (ou equivalente claro). Teste table-driven com tick atrasado > 25 ms mantendo cadência.

### B6 — Cast DOM sem verificação
- Mover utilitário de DOM para `web/src/ui/dom.ts`; `requireElement(id, ctor)` checando `instanceof`. Atualizar `join.ts`/`hud.ts`.

### B7 — `decodeClient` retornando `any`
- `internal/realtime/protocol.go`: retornar tipo concreto (ex.: struct com campo de tipo + payloads tipados, ou interface fechada `clientMsg` com método não exportado). Escolher o mais idiomático e simples.

## Fora (fase 2)
- Rate limit por sessão e limite de conexões; limite de `Space.last`. Registrar em `specs/backlog.md`.

## Verificação obrigatória
- `go vet ./...`, `go test -race ./...`, `staticcheck` via `go run honnef.co/go/tools/cmd/staticcheck@latest ./...` se viável.
- `cd web && npm test && npm run build`.
- Subir servidor (`VB_OFFICE32_ADDR=127.0.0.1:18080`) e rodar `loadbot -n 50 -duration 10s`.
- Grep do rename conforme A.
