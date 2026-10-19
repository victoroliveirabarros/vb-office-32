# Fase 4 — Chat de texto

Base: fases 1–3 (`phase1-protocol.md`, `phase2.md`, `phase3.md`), `security-hardening.md`. Mesmos padrões: Go idiomático, stdlib, comentários mínimos, TS sem `any`. Repositório público.

## Contexto

- Sem banco de dados ainda. Chat em memória do processo (perde no restart — aceitável no piloto; 1 réplica).
- Servidor autoritativo: valida, limita, roteia. Cliente só exibe.
- Privacidade: conteúdo de mensagens **nunca** vai para log.

## Complexidade

Score 12 (médio): protocolo novo, regras de roteamento por escopo, UI nova com captura de teclado, segurança (XSS, flood).

## User story

Como colega, mando mensagem para todos do escritório, só para quem está perto de mim, ou direto para uma pessoa; vejo as últimas mensagens gerais ao entrar.

## Escopo

### A. Escopos

| Escopo | Destinatários | Histórico ao entrar |
|---|---|---|
| `everyone` | todos no espaço | últimas 100 mensagens (memória) |
| `nearby` | remetente + conjunto `nearby` do remetente **no momento do envio** (mesma regra de proximidade da fase 3, calculada mesmo sem mídia) | não |
| `direct` | remetente + destinatário (por id), se online | não |

- `direct` para alguém offline → erro `"offline"` para o remetente (sem fila).

### B. Protocolo (atualizar `phase1-protocol.md`)

- Cliente → servidor `chat`: `{ cid: string, scope: "everyone"|"nearby"|"direct", to?: string, text: string }`. `cid` (id do cliente, ≤ 36 chars) só para correlacionar eco/erro.
- Servidor → cliente `chat`: `{ id, at (unix ms), from, fromName, scope, to?, text, cid? }` (`cid` só no eco para o remetente).
- Servidor → cliente `chatHistory`: `{ messages: Chat[] }` logo após `welcome` (antes de `media`/`nearby`, ou definir ordem no refinamento).
- Servidor → cliente `chatError`: `{ cid, reason: "rate_limited"|"too_long"|"empty"|"offline"|"invalid" }`.
- `nearby` precisa existir mesmo sem mídia? Proximidade já é calculada sempre; decidir no refinamento se o servidor passa a enviar `nearby` sem mídia (útil para UI "quem está perto").

### C. Regras do servidor

- Texto: `strings.ToValidUTF8`, remover controles exceto `\n`, remover `Cf` (bidi), normalizar quebras (`\r\n`→`\n`), máx. 3 quebras seguidas, trim; vazio → `empty`; > 500 runes → `too_long` (não truncar silenciosamente).
- Rate limit de chat separado do bucket geral: ~5 mensagens / 10 s, burst 5 → `rate_limited` (não derruba a conexão; o bucket geral de 20/s continua valendo).
- `id` gerado no servidor (monotônico por espaço ou `rand.Text` curto); `at` do servidor.
- Histórico `everyone`: ring buffer de 100 por espaço.
- Nome do remetente vem da sessão (nunca do cliente).
- Nada de conteúdo nos logs (só contadores/motivos de recusa).

### D. Cliente

- Painel de chat lateral/inferior, colapsável, com abas **Todos**, **Perto** e conversas **diretas** (abrir DM clicando no nome na lista de presentes ou no avatar).
- Lista de presentes (quem está no espaço; marcar quem está perto).
- `Enter` foca o input; `Esc` sai. **Com input focado, teclas não movem o avatar** (Phaser keyboard capture desligada/ignorada enquanto focado).
- Renderização só com `textContent` (sem HTML, sem markdown); quebras de linha preservadas via CSS (`white-space: pre-wrap`); links não clicáveis nesta fase.
- Badge de não lidas por aba; scroll automático só se já estava no fim.
- Envio otimista com estado "enviando" até eco (`cid`); erro mostra motivo.
- Histórico recebido ao conectar (reconexão substitui, sem duplicar).

## Fora

- Persistência em banco, busca, edição/remoção, reações, anexos, markdown/links clicáveis, notificações do sistema, moderação.

## Critérios de aceite

- `everyone` chega a todos; `nearby` só a quem estava perto no envio (+ remetente); `direct` só aos dois; `direct` offline → `chatError offline`.
- Recém-chegado recebe as últimas ≤ 100 mensagens `everyone`, nunca `nearby`/`direct`.
- Texto com HTML/bidi/controles exibido literalmente e sem efeito; > 500 runes → `too_long`.
- Flood → `rate_limited` sem derrubar a conexão.
- Digitar no chat não move o avatar.
- Nenhum conteúdo de mensagem nos logs.
- `go vet`, `go test -race`, staticcheck, govulncheck, `npm test`, `npm run build` verdes; loadbot sem regressão.

---

# Refinamento técnico (vence o texto acima em caso de conflito)

## Divisão

- **4a — servidor e protocolo** (vai a produção sozinho; clientes atuais ignoram tipos novos). Começa após o merge do hardening (S1 mexe em `room.go`).
- **4b — cliente** (após S2, que move o CSS inline para arquivo e liga a CSP).
- **4c — opcional/backlog:** DM por clique no avatar, desambiguação de nomes repetidos, bucket de `everyone` por Room, TTL do histórico, bucket por identidade, alias opaco no lugar de `oidc:<sub>`.

## 4a — decisões

- Pacote puro `internal/chat` (sem goroutine, relógio ou JSON): `Scope` (`everyone|nearby|direct`, `Valid()`), `Clean(text) (string, error)`, `MaxRunes=500`, `MaxLines=20`, `HistorySize=100`, `ErrEmpty`, `ErrTooLong`, `Message`, `History` (ring buffer, `Messages()` cópia mais antiga primeiro), `IDs` (prefixo aleatório de boot + contador base36).
- `Clean`, em ordem: `ToValidUTF8`; `\r\n`, `\r`, U+0085, U+2028, U+2029 → `\n`; `\t` → espaço; remove `Cc` (exceto `\n`); remove `Cf` **exceto ZWJ/ZWNJ** quando a rune anterior não é ASCII/espaço/Cf e a seguinte existe e não é espaço (colapsa repetidos) — preserva emoji compostos, bandeiras regionais, skin tones, ZWNJ persa; bidi, BOM, soft hyphen e tags E0020–E007F sempre saem; remove espaços no fim de cada linha; > 3 `\n` seguidos → `\n\n\n`; `TrimSpace`; vazio → `empty`; > 500 runes ou > 20 linhas → `too_long`. Sem NFC. `FuzzClean` (UTF-8 válido, sem Cc além de `\n`, sem bidi, idempotente).
- Sessão (goroutine de leitura, fora do actor): parse, validação, `Clean`, `chatLimiter` (`tokenBucket` 0,5/s burst 5; token gasto só em mensagem válida; ordem `invalid` → `empty`/`too_long` → `rate_limited`). Bucket geral de 20/s continua contando antes.
- `maxMessageSize` → **8 KiB** (colar texto grande gera `too_long`, não close 1008).
- Close 1008: JSON inválido, tipos errados, `cid` ausente/> 36/fora de `[A-Za-z0-9_-]`. `chatError invalid`: escopo desconhecido, `direct` sem `to`, `to` fora de `direct`, `to == self`, `to` > 300 bytes. `direct` inexistente/ausente → `offline` (mesma resposta).
- Room: canal `chats` (buffer 64), lógica em `room_chat.go`. `FromName` da sessão. `nearby` usa `space.Nearby(from)` (estado do último tick) + remetente; conjunto vazio → só eco. Encode duas vezes (sem `cid` para outros, com `cid` no eco). `everyone` → `history.Add` e invalida cache `historyMsg []byte`.
- Ordem do join: `welcome` → `media` (se mídia) → `nearby` (**sempre**) → `chatHistory` (**sempre**, mesmo vazio; maior frame, por último) → broadcast `joined`.
- **`nearby` passa a ser enviado sempre**, com ou sem mídia (tirar o gate em `handleJoin` e `tick`; ajustar `TestNoMediaWithoutIssuer` e `phase1-protocol.md`).
- Formatos: C→S `chat {cid, scope, to?, text}`; S→C `chat {id, at(ms), from, fromName, scope, to?, text, cid?}` (`to` só em direct; `cid` só no eco); `chatHistory {messages}` (≤ 100, só everyone, sem cid); `chatError {cid, reason}`.
- Logs: proibido texto, `to` e `cid`; só `chat rejected` com `reason` em Debug. Teste com slog em buffer.
- Testes: `TestClean` (casos de emoji/bidi/HTML literal/limites), `FuzzClean`, `History`, `IDs`; mapa `testdata/line.tmj` (12×1) para integração com 3 clientes (everyone, nearby, direct, offline, invalid, histórico 105/100, ordem do join com e sem mídia, rate limit sem derrubar, too_long com 2000 runes de 4 B, logs sem conteúdo); `BenchmarkChatEveryone200`; loadbot `-chat`.

## 4b — decisões

- `web/src/chat/{clean.ts, roster.ts, state.ts, keys.ts}` puros + testes; `web/src/ui/chat.ts` (só `textContent`, `hidden`, `classList`, `aria-*`, `dir`; proibido `innerHTML`/`insertAdjacentHTML`).
- `clean.ts` espelha o Go; contagem com `Array.from(text).length` sobre texto limpo; contador `n/500` e bloqueio no cliente. Vetores compartilhados opcionais em `internal/chat/testdata/clean.json`.
- `ChatState`: abas `everyone`, `nearby`, `dm:<id>` (chave `from === selfId ? to : from`); dedupe por id; pendentes por `cid` (contador por página, não `randomUUID`); `chatError` marca falha; não lidas (próprias e histórico não contam); DM recebida cria aba; cap ~200 por aba; no `welcome` pendentes viram falha; `chatHistory` substitui a aba Todos mantendo pendentes no fim.
- Roster próprio de `welcome`/`joined`/`left` + `nearby`; ordenado com `localeCompare('pt-BR')`; clicar no nome abre DM; DM com offline mostra "offline" e desabilita envio.
- **Teclado (Phaser 4.2.1):** `addKey` captura e chama `preventDefault` no `window` mesmo com plugin desligado. `OfficeScene.setTyping(on)`: `kb.enabled = !on`, `disableGlobalCapture()`/`enableGlobalCapture()`, `resetKeys()`; `update()` retorna cedo se digitando; `stopPropagation()` em keydown/keyup do textarea; `TypingGate` passado do `main.ts`. Enter global (no `document`) com `shouldFocusChat` faz `preventDefault()` **antes** de `focus()`; ignora `isComposing`/keyCode 229. No textarea: Enter envia, Shift+Enter quebra linha, Esc `blur()`.
- A11y: `role="log"` + `aria-busy` na troca de histórico; `tablist`/`tab`/`aria-selected`, badge no `aria-label`; textarea `aria-label="Mensagem"`; erro/contador `role="status"`; `dir="auto"`.
- CSS no arquivo criado pelo S2; texto com `white-space: pre-wrap; overflow-wrap: anywhere; unicode-bidi: isolate`. Aviso na aba Todos: "visível para quem entrar".
- E2E com build servido pelo Go (CSP ativa): WASD no chat não move avatar; segurar D + Enter + soltar para o avatar; HTML/RLO literais; flood → rate_limited; reconexão sem duplicar; console sem violação de CSP.
