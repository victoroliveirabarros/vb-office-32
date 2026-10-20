# Fase 7 — Mesas individuais, zonas privadas nas mesas e tela em toda zona

Base: fases 3–6 (`phase3.md`, `phase5.md`, `phase6.md`, `phase6-3-avatars.md`, `phase6-4-sidebar.md`, `security-hardening.md`). Mesmos padrões: Go idiomático, stdlib, comentários mínimos, TS strict sem `any`, CSP restritiva, a11y, tema claro/escuro. Repositório público (nenhum e-mail real em arquivos versionados).

## Contexto

- O mapa (`tools/officeart/office.txt` → `maps/office.tmj`) tem 12 baias: dois blocos 3×2, x 15..23 e 26..34, mesas (`D`, sólidas) em y 14..15, cadeiras em y 13 (fileira norte) e y 16 (fileira sul), estações de 3 tiles. Faixas livres y 10..12 e y 17..18, corredor x 24..25.
- Zonas (fase 5): `Zone{ID, Name, Kind}` com `meeting`/`private`, sem sobreposição, audição = mesma zona, privacidade de mídia por permissões do publicador (`nearby`). Tela só em `meeting`, no máximo 1 tela assinada.
- Sessão (`internal/auth/session.go`) guarda só o **domínio** do e-mail; identidade é `oidc:<sub>`. Não há banco.

## Decisões do usuário

1. **Dono da mesa por configuração**: e-mail → id da mesa, editado pelo admin (redeploy). Sem banco.
2. **Acesso à zona da mesa: só dono + convidados.** O servidor impede os demais de entrar.
3. **Compartilhamento de tela em toda zona** (reunião, privada, ringue, mesas), visível só para quem está na mesma zona.

## Complexidade

Score 14 (complexo): mapa/zonas (3), sem deps (1), sem banco mas sessão muda (2), LiveKit existente (2), regra de acesso no movimento autoritativo + convites (3), risco médio-alto por privacidade/sessão (3).

## User story

Como colega, tenho minha mesa com meu nome. Quem está nela comigo conversa só comigo; ninguém entra sem eu convidar. Lá dentro compartilho minha tela com quem convidei.

## Escopo

### A. Mapa: zonas de mesa

- Novo `kind` `desk`. Uma zona por estação (12), ids `mesa-01`..`mesa-12` (ordem: bloco oeste→leste, fileira norte→sul, oeste→leste), nome padrão "Mesa N".
- Retângulo cobre a fileira da cadeira + a fileira da mesa da estação (3×2). Conferir que cada zona tem tile andável, não sobrepõe outras zonas e que portas/spawns/faixas livres/corredor continuam fora de zonas e alcançáveis (nenhum caminho do mapa passa obrigatoriamente por uma mesa).
- Zonas geradas pelo `tools/officeart` (literais Go como as atuais), golden test atualizado.
- `tilemap`: aceitar `desk` nas validações.

### B. Configuração de donos

- Nova config (ex.: `VB_OFFICE32_DESKS_FILE` apontando para JSON montável via ConfigMap; ou env inline — refinamento decide, compatível com EKS/Helm `open-api`): `{"mesa-01": {"email": "...", "name": "Fulano"}, ...}`; `name` opcional (placa quando o dono está offline).
- Validação no startup (erro fatal): id inexistente no mapa ou de zona não-`desk`, e-mail inválido ou repetido. E-mail comparado em minúsculas.
- Mesas sem dono configurado: zona `desk` livre (qualquer um entra), tela permitida.
- `.env.example`, README e `docs/deploy.md` documentam o formato com e-mails fictícios.

### C. Sessão: identificar o dono

- A sessão precisa saber se o usuário é dono de alguma mesa. Opções (refinamento decide; preferir não guardar e-mail em claro no cookie): resolver o id da mesa no login (callback OIDC) e guardar só `desk` na sessão, ou guardar HMAC do e-mail. Reavaliar no reconnect/rotação de chave. Dev IdP (`cmd/devidp`) e modo dev precisam funcionar (e-mails fictícios configuráveis).
- `email_verified` obrigatório para casar o dono.

### D. Regra de acesso (servidor, autoritativo)

- Mesa com dono: só entra em tile da zona quem é o dono ou está convidado por ele. Movimento para tile bloqueado é rejeitado como tile sólido (posição não muda; cliente corrige pela reconciliação existente).
- Convite: dono convida/revoga por identidade. Convite vale enquanto o dono estiver conectado (com a mesma tolerância de reconexão já existente) ou até ser revogado; some se o convidado desconectar? (refinamento decide; registrar a escolha).
- Revogação, ou dono desconectando, com convidado dentro: servidor move o convidado para o tile livre mais próximo fora da zona (BFS), avisa o cliente e recalcula audição/permissões na mesma rodada.
- Dono pode entrar sempre; se o dono estiver offline, ninguém entra (exceto mesa sem dono).
- Spawn do dono: ao entrar no escritório, nasce na cadeira da própria mesa (se configurada); demais regras de spawn intactas.
- Audição e chat "Perto" na mesa: regra de zona existente (mesma zona).

### E. Protocolo

- S→C `desks`: estado público das mesas `{id, owner: {id?, name}, online, locked}` no join e em mudanças (quem é dono, se está aberta). Lista de convidados só vai ao dono e ao convidado (`deskInvite` S→C: "X convidou você", "convite removido").
- C→S `deskInvite {target}`, `deskRevoke {target}`; só o dono da mesa; rate limit como o chat; alvo inexistente/ele mesmo → erro ignorado.
- S→C correção de posição quando o servidor tira o convidado da zona (reaproveitar mensagem existente se houver).
- Clientes atuais ignoram mensagens novas (sem quebrar).

### F. Tela em toda zona

- `canShare`: qualquer zona (`kind` não vazio), não só `meeting`. Fora de zona continua proibido.
- Mantém: 1 tela por zona por vez, preset `h720fps5`, parar ao sair/trocar de zona, assinatura só para mesma zona e `nearby`.
- Docs (`docs/livekit.md`, README) atualizados.

### G. Cliente

- Placa/nome do dono em cada mesa no mapa (Phaser), ícone de cadeado nas mesas fechadas para mim; overlay sutil das zonas de mesa (mais discreto que salas).
- Predição de movimento respeita mesas bloqueadas (não "atravessar" e voltar).
- Pessoas: ação "Convidar para minha mesa"/"Remover convite" (só se tenho mesa); clique no avatar oferece o mesmo. Toast para o convidado com o nome do dono.
- Salas: seção "Mesas" com dono, online e quem está dentro; "Ver na visão geral".
- Faixa/mini-perfil: "Mesa de Fulano" ao estar numa mesa; aba "Perto" vira "Mesa de Fulano".
- Botão de tela habilitado em qualquer zona.

## Fora

- Reivindicar mesa pelo app, persistência em banco, troca de mesa sem redeploy.
- "Bater na porta"/pedido de entrada (backlog).
- Status "não perturbe", mesas de hot desk com reserva, teletransporte para a mesa depois do spawn.

## Critérios de aceite

- Usuário configurado nasce na própria mesa e vê seu nome na placa.
- Outro usuário não consegue entrar na mesa (nem com cliente modificado enviando movimentos); com convite entra e conversa; ao revogar é colocado fora e deixa de ouvir/ver.
- Dono offline: mesa fechada; mesa sem dono: aberta a todos.
- Quem está fora da mesa não ouve, não vê e não assina trilhas de quem está dentro (permissões existentes).
- Tela compartilhável em reunião, sala privada, ringue e mesas; vista só pela mesma zona; para ao sair.
- Config inválida falha no startup com mensagem clara; nenhum e-mail real versionado.
- `go vet`, `go test -race ./...`, staticcheck, govulncheck, `npm test`, `npm run build` verdes; e2e existentes passando e um e2e novo (convite/entrada/revogação); loadbot sem regressão; screenshots claro/escuro.

---

# Refinamento técnico (vence o texto acima em caso de conflito)

Fontes conferidas em 2026-10-19: `tools/officeart/office.txt` e `tmj.go`, `maps/office.tmj`, `internal/tilemap`, `internal/world`, `internal/auth`, `cmd/devidp`, `cmd/vb-office-32`, `internal/realtime`, `cmd/loadbot`, `web/src` (`net/protocol.ts`, `game/{zones,grid,prediction}.ts`, `scenes/OfficeScene.ts`, `chat/roster.ts`, `media/{screen,client}.ts`, `sidebar/places.ts`, `ui/{rooms,people,profile,hud,zone,chat}.ts`, `main.ts`), `web/e2e/*`, `docs/deploy.md`, `docs/livekit.md`, `.env.example`, `Dockerfile`.

## Divisão

- **7a — mapa, config, sessão, acesso e protocolo no servidor + mínimo no cliente para não regredir.** Vai a produção sozinha: sem arquivo de donos as 12 mesas ficam abertas (só viram zonas isoladas); com arquivo o bloqueio já vale no servidor (cliente ainda prevê entrada e volta pela correção existente, aceito até a 7b).
- **7b — cliente:** estado das mesas, predição com bloqueio, placas/cadeado, convites (Pessoas e clique no avatar), toast, seção "Mesas" em Salas, "Mesa de Fulano" na faixa/mini-perfil/aba, e2e novo, screenshots.
- **7c — tela em toda zona:** só cliente + docs; independente da 7b, mas trata troca direta de zona (que só existe a partir da 7a).

## 7a — decisões

### Mapa (`tools/officeart/tmj.go`, `make art`)

- 12 literais `zone` em `zones` (depois dos 3 atuais), nome `"Mesa N"`, id `mesa-NN`, kind `desk`, 96×64 px (3×2 tiles: fileira da cadeira + fileira da mesa). Ordem: bloco oeste (norte O→L, sul O→L), depois bloco leste.

| id | px (x, y, w, h) | tiles x / y | assento (cadeira `c`) |
|---|---|---|---|
| mesa-01 | 480, 416, 96, 64 | 15..17 / 13..14 | (16, 13) |
| mesa-02 | 576, 416, 96, 64 | 18..20 / 13..14 | (19, 13) |
| mesa-03 | 672, 416, 96, 64 | 21..23 / 13..14 | (22, 13) |
| mesa-04 | 480, 480, 96, 64 | 15..17 / 15..16 | (16, 16) |
| mesa-05 | 576, 480, 96, 64 | 18..20 / 15..16 | (19, 16) |
| mesa-06 | 672, 480, 96, 64 | 21..23 / 15..16 | (22, 16) |
| mesa-07 | 832, 416, 96, 64 | 26..28 / 13..14 | (27, 13) |
| mesa-08 | 928, 416, 96, 64 | 29..31 / 13..14 | (30, 13) |
| mesa-09 | 1024, 416, 96, 64 | 32..34 / 13..14 | (33, 13) |
| mesa-10 | 832, 480, 96, 64 | 26..28 / 15..16 | (27, 16) |
| mesa-11 | 928, 480, 96, 64 | 29..31 / 15..16 | (30, 16) |
| mesa-12 | 1024, 480, 96, 64 | 32..34 / 15..16 | (33, 16) |

- Regra do centro em `[x, x+w) × [y, y+h)` → exatamente 3×2 tiles; vizinhos só encostam; sem cruzar `reuniao`/`privada`/`ringue`. Cada mesa tem 3 tiles andáveis (fileira da cadeira); fileira `D` sólida.
- Spawns (x 14, 19, 24, 29, 34; y 11 e 18) e portas (11, 13..14), (38, 13..14), (18..19, 9) fora das mesas.
- BFS conferido sobre `solid` a partir de (14, 11) com as 72 casas das mesas bloqueadas: os 548 tiles livres fora das mesas são alcançáveis (faixas y 10..12 e 17..18, corredor x 24..25, laterais x 12..14 e 35..37).
- Camada `areas` não muda (`escritorio` cobre as mesas; zona tem prioridade — `areaOf` devolve null dentro de zona).
- Golden regenerado: muda só o `.tmj` (objetos e `nextobjectid`); PNG igual.

### `internal/tilemap`

- `Desk Kind = "desk"` em `Valid()`.
- Validação nova para todos os kinds: zona sem tile andável → erro `zone %q has no walkable tile`. Spawn em zona já coberto.
- `(*Map).ZoneIndex(id string) int` (-1 se não existe).
- `(*Map).Seat(i int) Point`: tile andável da zona mais perto do centro do retângulo; empate → menor y, depois menor x (cadeira do meio nas 12 mesas).
- `(*Map).Outside(from Point) Point`: BFS por tiles andáveis, vizinhos cima/baixo/esquerda/direita, até o primeiro tile fora de toda zona; fallback `Spawns[0]`. Do assento norte dá y 12; do sul, y 17.

### Configuração (`cmd/vb-office-32/desks.go`)

- Primário `VB_OFFICE32_DESKS_FILE` → JSON (EKS: ConfigMap montado `readOnly` em `/app/config/desks.json`, compatível com `readOnlyRootFilesystem`). Alternativa `VB_OFFICE32_DESKS` com o mesmo JSON inline. As duas juntas → erro.
- Formato `{"mesa-01": {"email": "ana@example.com", "name": "Ana Souza"}}`. Teto 64 KiB, `DisallowUnknownFields`, id repetido detectado via `json.Decoder.Token`. E-mail: ASCII, `mail.ParseAddress` com `Address == entrada`, ≤ 254, minúsculas, sem repetição. `name` opcional: 1..32 runes, sem controle. Em modo oidc o domínio precisa estar em `VB_OFFICE32_ALLOWED_DOMAINS`. Erros citam variável e id da mesa, **nunca o e-mail**.
- Após `tilemap.LoadFile` em `run`: id inexistente ou zona não-`desk` → fatal.
- Lida só no boot; troca exige redeploy (anotação `checksum/desks` no Helm; rollout `Recreate`). Mesa ausente do JSON = livre.

### Sessão (`internal/auth`) — HMAC do e-mail

- Escolhido porque `desk` no cookie manteria a mesa antiga até 12 h após troca na config (risco de dois donos). Config do processo é fonte de verdade a cada conexão WS.
- `sessionPayload.ET string \`json:"et,omitempty"\`` = `base64url(HMAC-SHA256(k, lower(email)))[:16 bytes]`, `k = hkdf(secret, "vb-office-32 desk-owner v1")`. Gravado em todo login com e-mail verificado (mesa dada depois vale sem novo login).
- `OIDCConfig.Desks map[string]string` (e-mail minúsculo → mesa). `NewOIDC` monta índice tag → mesa para a chave atual e a anterior (rotação).
- `Identity.Desk string`, preenchido em `Authenticate` com `o.deskTags[p.ET]`.
- Cookie anterior à 7a sem `et`: sem mesa até o próximo login (≤ 12 h). Documentar.
- `email_verified` já é exigido em `authorize`; tag só com `EmailVerified` (explícito). Tag nunca em log.
- Modo guest: `auth.Guest{Desks map[string]string}` (parte local minúscula → mesa); guest cujo nome minúsculo = parte local vira dono ("ana" ↔ `ana@example.com`). Duas mesas com a mesma parte local em guest → erro no boot. **PM:** guest escolhe o próprio nome, então isso só é aceitável onde guest já é dev-only — confirmar que guest não roda em produção (ou recusar desks com guest fora de dev) e documentar.
- devidp não muda (`ana@example.com`, `bruno@example.com` já existem).

### `internal/world` (enforcement)

- `Space.access []map[string]struct{}` por índice de zona; `nil` = aberta.
- `(*Space).Lock(zone string, ids ...string) error` troca o conjunto (vazio = ninguém). Quem está dentro sem acesso é ejetado na hora: `Pos = m.Outside(pos)`, `zone = -1`, fila e `nextStep` zerados, entra em `s.forced`. No próximo `Step`, cada `forced` vai para `Moved` e `Zones`, `Acks[id] = lastSeq` (entradas descartadas contam como consumidas → `pending` do cliente esvazia) e vai ao `check` sem histerese. Ainda no `Lock`, depois de ejetar todos, os pares do ejetado que deixaram de se ouvir (sem histerese) são desfeitos por `unlink`, então `Nearby` e o chat "Perto" já valem na hora e o `Delta.Nearby` sai no `Step`; os novos vizinhos esperam o `Step`. Reconexão da mesma identidade antes do `Step` mantém o `forced` (os outros ainda veem a saída em `Moved`/`Zones`), mas sem ack (`forced[id] = 0`, que não entra em `Acks`).
- `Step`: após `!Blocked(to)`, `z := ZoneAt(to)` uma vez (reaproveitado na troca de zona); só anda se `z == p.zone || z < 0 || access[z] == nil || allowed`. Bloqueado = sólido (direção muda, ack avança).
- `Join`: posição lembrada dentro de zona sem acesso → `Outside`.
- `(*Space).JoinAt(id, name string, at tilemap.Point) Player`: como `Join`, mas jogador novo/lembrado começa em `at`; se já presente, mantém posição. Para o assento do dono.
- `(*Space).Seat(zone string) (tilemap.Point, bool)`, `(*Space).Zones() []tilemap.Zone`.

### Realtime

- `(*Room).SetDesks(names map[string]string)` antes de `Run` (id → nome configurado); `Lock(id)` vazio em cada mesa com dono. Estado: `deskState{zone, id, name, ownerID, ownerName string, online bool, guests map[string]string, seq uint64, timer}`. `Session.desk` vem de `Identity.Desk`.
- **Posse:** no `handleJoin`, sessão com `desk` vira dona salvo se outra identidade já é dona online (Warn, entra sem mesa). Vira dona se `ownerID == ""` ou dono anterior offline; identidade mudou → convidados zerados. Então `Lock(desk, owner + guests)`.
- **Assento:** `JoinAt(seat)` quando dona, não é substituição e a mesa não está na carência. Reconexão na carência mantém posição.
- **Carência do dono:** `deskGrace = removeGrace` (30 s), com ou sem mídia, configurável em teste. Saída do dono: `online = false`, broadcast `desks`, timer com `seq`. Volta no prazo → cancela. Expira → convidados zerados, `Lock(desk, owner)` (ejeta), `deskInvite{invited:false}` aos convidados online, `deskGuests` vazio.
- **Convites por identidade**, sobrevivem à desconexão do convidado (recarregar não expulsa; dono vê offline e pode revogar). Terminam por revogação ou expiração da carência. Alvo do convite precisa estar online; da revogação não. Teto 20 por mesa; repetido = no-op.
- **Ordem do join:** `welcome` → `media` (se) → `zone` → `desks` (só se o mapa tem `desk`) → `deskGuests` (se dono) → `deskInvite` (um por convite ativo) → `nearby` → `chatHistory`. Outros: `joined` → `desks` (se online mudou). Saída: `left` → `desks`. Mapas de teste sem mesas mantêm a ordem atual.
- **Correção de posição:** `state` existente (posição + ack). Sem mensagem nova.
- **Revogação:** `Lock` → `deskInvite{invited:false}` ao alvo → `deskGuests` ao dono; no tick seguinte (≤ 50 ms) `state`, `zone {id:""}` e `nearby`, e os clientes ajustam permissões de mídia.
- **Rate limit:** `sessionLimits.desk = newIdentityLimits(chatRate, chatBurst)` (0,5/s, rajada 5); também contam no `messageRate`. Canal `desks` com buffer 64.

### Protocolo (JSON)

- S→C `desks` (todos): `{"desks":[{"id":"mesa-01","owner":{"id":"oidc:…","name":"Ana Souza"},"online":true,"locked":true},{"id":"mesa-05","online":false,"locked":false}]}`. `locked` = tem dono (independe de quem recebe). `owner.id` só depois que o dono conectou neste processo. `owner.name`: sessão se online; senão nome configurado, último nome de sessão ou nome da zona.
- S→C `deskGuests` (só dono): `{"desk":"mesa-01","guests":[{"id","name","online"}]}`, ordenado por id.
- S→C `deskInvite` (só convidado): `{"desk":"mesa-01","owner":"oidc:…","ownerName":"Ana Souza","invited":true|false}`.
- C→S `deskInvite {target}`, `deskRevoke {target}`. JSON malformado ou `target` não-string → fecha 1008 (como as demais). `target` vazio, > `maxToLen`, próprio id, desconhecido, remetente sem mesa ou acima do limite → ignorado (Debug).
- Cliente atual ignora S→C desconhecido; cliente antigo em cache trata `kind:"desk"` como `private`.

### Mínimo no cliente (7a)

- `ZoneKind` inclui `'desk'` (`protocol.ts`, `zones.ts`). `OfficeScene` não desenha placa de parede para `desk` (contorno amarelo continua). `places()` exclui mesas de Salas; quem está em mesa conta como "Escritório aberto" até a 7b. `KIND_TEXT`/`KIND_HINT`: "mesa" e "Só quem está na mesa ouve, vê e lê o chat “Perto”."

### Docs

- README (variáveis novas, isolamento das estações), `docs/deploy.md` (ConfigMap + volume + mount + `checksum/desks`), `.env.example` (`# VB_OFFICE32_DESKS_FILE=docs/desks.example.json`), `docs/desks.example.json` (`mesa-01` ana@example.com "Ana Souza", `mesa-02` bruno@example.com "Bruno Lima", `mesa-07` dani@example.com sem nome), `specs/phase1-protocol.md` (mensagens novas e ordem do join).

## 7a — testes

- tilemap: kind `desk`; zona sem andável; `Seat` (centro e desempate), `Outside` (determinístico e fallback), `ZoneIndex`; `TestOfficeMap` com 15 zonas, os 12 retângulos/assentos da tabela, 3 andáveis por mesa, portas e spawns fora; BFS de um spawn sem pisar em mesas alcança todo tile livre fora delas.
- officeart: golden atualizado.
- world: movimento para zona trancada rejeitado (posição igual; direção e ack mudam); permitido entra; andar dentro/sair livre; `Lock` com alguém dentro (ejeção, `Delta` com `Moved`/`Zones`/`Acks=lastSeq`/`Nearby` sem histerese, fila zerada); `Join` lembrado em zona trancada sai; `JoinAt` no assento e substituição ignorando `at`; random walk: ninguém sem acesso em zona trancada; `BenchmarkStepProximity200`/`200Zones` sem regressão (≤ 5%) + `BenchmarkStepProximity200Locked`.
- auth: `et` presente e payload sem `@` (atualizar `TestSessionPayloadHasNoEmail`); `Identity.Desk` case-insensitive; cookie sem `et` sem mesa; troca de config muda a mesa com o mesmo cookie; tag da chave anterior resolve na rotação; não verificado nunca loga; guest pela parte local.
- config: arquivo e inline; ambas → erro; campo desconhecido, id duplicado, e-mail inválido/repetido, domínio não permitido, nome inválido; id fora do mapa e zona não-`desk`; erro sem ecoar e-mail; boot com o exemplo em `main_test`.
- realtime: ordem do join com/sem mesas; posse e `desks` online/offline; assento no join novo × posição mantida (substituição, carência); movimentos crus de não dono nunca entram; convite (`deskInvite` + `deskGuests`), entrada, revogação (ejeção + `zone ""` + `nearby` no mesmo tick + `invited:false`); carência curta expira e ejeta; dono volta na carência e mantém convidados; convidado reconecta e segue convidado; não dono/alvo inválido ignorado; `target` numérico fecha 1008; rate limit; teto 20; segunda identidade com a mesma mesa fica sem ela; chat "Perto" fica na mesa.
- loadbot: `make loadbot` antes e depois, latência e taxa iguais.

## 7b — decisões

- `web/src/game/desks.ts`: `Desks` com `{id, ownerId?, ownerName?, online, locked}`, `guests` (se dono), `invites` (Set de mesas que me convidaram). `lockedForMe(desk, self) = locked && ownerId !== self && !invites.has(id)`. `deskLabel(zone, desk)` → `"Mesa de ${ownerName}"` ou nome da zona sem dono.
- Parse em `protocol.ts` (`desks`, `deskGuests`, `deskInvite`; inválido → null); C→S `deskInvite`/`deskRevoke`.
- Predição: `Grid.move(from, dir, gate?)`, `gate` espelha o servidor (bloqueia se a zona destino ≠ origem e trancada para mim). `Predictor.setGate(fn)` atualizado a cada `desks`/`deskInvite`/`welcome`.
- Phaser: placa por mesa centrada na fileira `D` (y 14 norte, y 15 sul): pílula `#0E3A58` alpha 0,9, texto branco Montserrat 700 9 px em 1× na tela, truncado com "…" na largura da estação; cadeado amarelo `#FDC339` e véu `#00263E` alpha 0,10 quando trancada para mim; contorno amarelo mais fino (1,5 px, alpha 0,6) na mesa atual. Placas visíveis em todos os níveis.
- Roster guarda mesas; `Room.name` das mesas vem de `deskLabel`, recalculado a cada `desks`. Faixa (`hud.setZone` alimentado pelo feed), mini-perfil, lugar em Pessoas e aba "Perto" (`roster.room?.name`) mostram "Mesa de Fulano"; tag "na mesa"; aviso "visível só para quem está na mesa".
- Pessoas: "Convidar para minha mesa"/"Remover convite" (Lucide `user-plus`/`user-minus` no sprite), só se tenho mesa e só para outros.
- Clique no avatar: com mesa, popover com "Mensagem direta" + convite; sem mesa, DM direto.
- Toast (`role=status`, 5 s): "Ana Souza convidou você para a mesa" / "Convite para a mesa de Ana Souza removido".
- Salas: seção "Mesas" (`#desks-list`) após as salas: nome, "Online"/"Offline · fechada"/"Livre", contagem, rostos, "Ver na visão geral" (`showPlace`). Quem está em mesa conta nela. Ícones `armchair`, `lock`, `lock-open`.
- e2e `web/e2e/desks.mjs` (guest + `VB_OFFICE32_DESKS_FILE=docs/desks.example.json`): "ana" nasce em (16, 13) e vê o nome na placa; "eve" pelo teclado não entra, WS cru do Node mandando `move` também não; ana convida → toast → eve entra → aba "Mesa de ana" → `nearby` mútuo; revogação → eve em (16, 12) sem `nearby`; ana desconecta → `online:false`; zero violação de CSP; screenshots claro/escuro 1280×800 e 390×844. Atualizar expectativas de Salas em `sidebar.mjs`.

## 7b — testes

- Vitest: parse das 3 mensagens (válidas/inválidas); `zones.ts` com `desk`; `lockedForMe`, `deskLabel`; gate do `Grid`/`Predictor`; nomes no roster; `places` sem mesas e lista de Mesas; nome da aba; textos de `zone.ts`; visibilidade das ações; texto do toast. e2e novo + existentes verdes.

## 7c — decisões

- `media/screen.ts`: `inZone(zone) = zone !== null && zone.id !== ''` no lugar de `inMeeting` em `canShare`, `screenTarget`, `yieldsScreen`. `shouldStop(sharing, zone)` para ao sair **ou trocar** de zona (fileiras contínuas: x 17 → 18 vai de `mesa-01` direto para `mesa-02`); `MediaClient` guarda `screenZone`; `permissionsOnlyShrink(zone, screenZone, live, busy) = (live || busy) && zone?.id !== screenZone`.
- Mantém `h720fps5`, 1 tela por zona (cliente), assinatura só mesma zona e `nearby`. `docs/livekit.md` ("Screen sharing") e README: "qualquer zona". Servidor segue tolerando tela fora de zona.

## 7c — testes

- `screen.test.ts`: cada kind, fora de zona, troca direta de zona. `client.test.ts`: mesa A → mesa B com tela ligada para sem alargar permissões. Opcional: `web/e2e/intruder.html` com Ana numa mesa, registrar latências.

## Riscos e correções ao texto acima

- **Isolamento novo no escritório aberto:** toda estação vira zona, inclusive sem dono; vizinhos de mesa e quem passa atrás da cadeira deixam de se ouvir por proximidade. Consequência das decisões 2 e 3; alternativa (mesa livre sem isolamento) descartada por fazer a semântica depender da config. Registrar no README.
- "Mesma tolerância de reconexão": hoje a carência de 30 s é só da mídia; a 7a cria carência própria da mesa (30 s), sem mídia também.
- `email_verified` já exigido; item C só pede teste.
- `locked` público = "tem dono"; "fechada para mim" derivado no cliente.
- `deskGuests` (só dono) é mensagem a mais; `deskInvite` S→C só para o convidado.
- Spawn no assento só em join novo (não substituição/carência).
- Sessões antigas ganham mesa no próximo login (≤ 12 h).
- Conflito de dono (duas identidades com o mesmo e-mail): a online fica com a mesa.
- Cliente antigo em cache vê mesa como privada e volta ao tentar entrar em trancada, até recarregar.
- Erros novos: domínio da config em `ALLOWED_DOMAINS`; zona sem andável vale para todos os kinds.
