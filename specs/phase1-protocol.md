# Fase 1 — Contrato compartilhado (protocolo + mapa)

Fonte única de verdade entre `internal/` (Go) e `web/` (TS). Qualquer divergência: este documento vence.

## Coordenadas e tempo

- Unidade: tile. Origem top-left. `x` cresce para direita, `y` para baixo.
- Tile = 32×32 px.
- Tick do servidor: 20 Hz (50 ms).
- Cooldown de passo: 150 ms por jogador (1 tile por passo).
- `MaxPendingInputs = 8`: máximo de `move` enviados e ainda sem `ack` por conexão. O servidor descarta o excedente sem aplicá-lo; o cliente não envia nem prevê novo `move` enquanto tiver 8 pendentes (backpressure).
- `Dir`: `"up" | "down" | "left" | "right"`.

## Transporte

- WebSocket em `GET /ws`. A identidade depende do modo (`VB_OFFICE32_AUTH`):
  - `oidc` (padrão): identidade vem do cookie de sessão; `?name` é ignorado. Sem cookie válido (ausente, adulterado, expirado ou domínio fora da lista) → HTTP 401 antes do upgrade. Identidade = `"oidc:" + sub`; nome = claim `name` do provedor (fallback: parte local do email), sem caracteres de controle/formatação, trim, até 32 runes; acentos são válidos.
  - `guest` (desenvolvimento): `GET /ws?name=<nome>`. `name`: 1–24 chars, `[A-Za-z0-9 _-]`, trim de espaços. Inválido → HTTP 400 antes do upgrade. Identidade = `"guest:" + lowercase(name)`.
- Outra falha de autenticação → HTTP 401 com corpo genérico (`Unauthorized`), nunca o erro interno.
- Mesma identidade conectando de novo derruba a sessão anterior (close code 4001, reason `"replaced"`).
- Em modo `oidc`, a conexão fecha com 4002 reason `"session expired"` quando a sessão (12 h) expira.
- `GET /api/session` diz ao frontend qual tela mostrar: `oidc` → 200 `{id, name, auth: "oidc"}` ou 401 `{auth: "oidc"}`; `guest` → sempre 401 `{auth: "guest"}`. O email nunca é exposto.
- Recusas antes do upgrade (HTTP, sem WebSocket; no browser aparecem como close 1006):
  - Sem sessão válida (modo `oidc`) → 401.
  - Servidor encerrando (readiness falsa) → 503 `shutting down`.
  - Limite global de conexões (`VB_OFFICE32_MAX_SESSIONS`, default 200) atingido → 503 `server full`. Conta conexões, não identidades.
- Todas mensagens são texto JSON com envelope:

```json
{ "t": "<tipo>", "d": { ... } }
```

- Mensagem do cliente > 8 KiB ou inválida → close 1008.
- Rate limit por conexão: token bucket de 20 mensagens/s com burst 40. Conta toda mensagem recebida, inclusive inválida. Excedeu → close 1008 reason `"rate limit"`. O chat tem limites próprios, por identidade e por espaço, que não fecham a conexão (ver [Chat](#chat)).
- Cliente lento (buffer de envio cheio, 256 mensagens) → close 1008 reason `"slow consumer"`.
- Shutdown do servidor → close 1001 reason `"server restarting"`. O cliente reconecta com backoff.

### Close codes e ação do cliente

| code | reason | ação do cliente |
|---|---|---|
| 4001 | `"replaced"` | para; mostra "sessão aberta em outra aba" |
| 4002 | `"session expired"` | para; recarrega a página (volta à tela "Entrar") |
| 1001 | `"server restarting"` | reconecta com backoff |
| 1008 | `"rate limit"`, `"slow consumer"`, mensagem inválida | reconecta com backoff |
| 1006 | (sem close frame; inclui recusa HTTP antes do upgrade) | se a conexão nunca abriu e o modo é `oidc`, consulta `/api/session`: 401 → trata como 4002; senão reconecta com backoff |

## Tipos compartilhados

```ts
type Player = { id: string; name: string; x: number; y: number; dir: Dir }
type Pos    = { id: string; x: number; y: number; dir: Dir }
```

## Cliente → Servidor

| `t` | `d` | Regra |
|---|---|---|
| `move` | `{ seq: number, dir: Dir }` | Intenção de 1 passo. `seq` uint32 crescente por conexão. Fila por jogador com cap `MaxPendingInputs` (8); excedente descartado. |
| `ping` | `{ ts: number }` | Servidor responde `pong` com mesmo `ts`. |
| `chat` | `{ cid: string, scope: Scope, to?: string, text: string }` | Ver [Chat](#chat). `cid` é do cliente, só para casar eco e erro. |

## Servidor → Cliente

| `t` | `d` | Quando |
|---|---|---|
| `welcome` | `{ selfId: string, mapId: string, tickRate: number, stepMs: number, players: Player[] }` | Logo após conectar. `players` inclui o próprio. |
| `joined` | `Player` | Outro jogador entrou. |
| `left` | `{ id: string }` | Jogador saiu. |
| `state` | `{ tick: number, ack: number, players: Pos[] }` | Fim de tick em que houve mudança OU o `ack` do destinatário avançou. `players` = só quem mudou posição/direção no tick. `ack` = último `seq` processado do destinatário (0 se nenhum). |
| `pong` | `{ ts: number }` | Resposta a `ping`. |
| `media` | `{ url: string, token: string, expiresAt: number }` | Só com mídia configurada. Logo após `welcome` e reemitido a cada ~5 min (verificação a cada 1 min, então entre 5 e 6 min). `url` = URL WS do LiveKit; `token` = JWT de acesso (TTL 10 min); `expiresAt` = expiração do token em unix **ms**. |
| `zone` | `{ id: string, name?: string, kind?: "meeting" \| "private" }` | Sempre, com ou sem mídia; só para o próprio jogador. Ao conectar (fora de zona: `{ id: "" }`) e no fim de todo tick em que o destinatário cruzou a borda de uma zona (depois do `state` e antes do `nearby` desse tick). Fora de zona só vai `id`, vazio. Ver [Zonas](#zonas). |
| `nearby` | `{ ids: string[] }` | Sempre, com ou sem mídia. Ao conectar (mesmo vazio) e no fim de todo tick em que o conjunto do destinatário mudou (depois do `state` e do `zone` desse tick, se houver). Conjunto completo de quem o destinatário ouve (ver [Proximidade](#proximidade) e [Zonas](#zonas)), ordenado, sem o próprio. |
| `chat` | `Chat` | Mensagem de chat para o destinatário, ou eco para o remetente (com `cid`). |
| `chatHistory` | `{ messages: Chat[] }` | Ao conectar, sempre (mesmo vazio): últimas ≤ 100 mensagens `everyone`, mais antiga primeiro, sem `cid`. |
| `chatError` | `{ cid: string, reason: "invalid" \| "empty" \| "too_long" \| "rate_limited" \| "offline" }` | Chat recusado; só para o remetente. |

Ordem ao conectar: `welcome` → `media` (só com mídia) → `zone` → `nearby` → `chatHistory`; só então os outros recebem `joined`. Ordem no fim de um tick: `state` → `zone` → `nearby`. Sem mídia configurada o servidor nunca envia `media`. Clientes antigos ignoram tipos desconhecidos.

## Proximidade

- Distância euclidiana em tiles, em inteiros: `d² = dx² + dy²`.
- Par entra no conjunto com `d² ≤ 16` (4 tiles) e sai com `d² > 25` (5 tiles); `16 < d² ≤ 25` mantém o estado anterior (histerese).
- Simétrica: A está no conjunto de B ⇔ B está no de A. Paredes não bloqueiam.
- Vale para mídia e para o chat `nearby`. Calculada no tick: só posição conta (virar não muda nada). Jogador novo é avaliado no tick seguinte à entrada, por isso o primeiro `nearby` dele vem vazio; reconexão da mesma identidade mantém o conjunto. Quem sai é removido dos vizinhos, que recebem `nearby` no tick seguinte.
- Essa regra só vale entre dois jogadores fora de zonas; com zona, vale [Zonas](#zonas).
- Volume (cliente, fase 3b): 1,0 em `d ≤ 1`, linear até 0,2 em `d = 4`, 0,2 na faixa de histerese, 0 fora do conjunto.

## Zonas

- Retângulos da camada `zones` do mapa (ver [Mapa](#mapa)), de tipo `meeting` (sala de reunião) ou `private` (cabine). Um tile pertence à zona se o centro dele cai no retângulo; zonas nunca dividem tiles.
- Quem está numa zona ouve e é ouvido por todos da mesma zona, a qualquer distância, e por ninguém de fora, nem colado na porta. Fora de zonas vale a [Proximidade](#proximidade), só entre quem também está fora.
- Mudança de zona é imediata no tick em que o jogador cruza a borda: sem histerese, e quem sai de uma zona não herda a histerese da distância (dois que saem juntos a `d² = 25` não ficam no conjunto).
- O jogador recebe `zone` com a zona em que está ao conectar e a cada mudança; a zona dos outros não vai no protocolo (o cliente deriva das posições e do mapa, ambos públicos — presença por sala não é segredo).
- O chat `nearby` herda a regra: dentro de uma zona chega só a quem está nela.

### Token LiveKit

- JWT HS256 assinado com o segredo da API LiveKit. Claims: `iss` = API key, `sub` = ID do jogador, `name` = nome de exibição, `nbf`, `iat`, `exp`, `video`.
- `video`: `{"room":"<espaço>","roomJoin":true,"canPublish":true,"canPublishSources":["microphone","camera"],"canSubscribe":true,"canPublishData":false,"canUpdateOwnMetadata":false}`.
- O LiveKit renova sozinho o token de quem está conectado; o `media` novo só serve para um `connect` futuro. O cliente nunca reconecta a sala ao receber `media`.

## Chat

```ts
type Scope = "everyone" | "nearby" | "direct"
type Chat  = { id: string; at: number; from: string; fromName: string; scope: Scope; to?: string; text: string; cid?: string }
```

- `id` gerado pelo servidor (prefixo aleatório do boot + contador base 36), único no processo; `at` = hora do servidor em unix **ms**; `from` = id do remetente; `fromName` = nome da sessão do remetente no envio (nunca vem do cliente). `to` só em `direct`; `cid` só no eco para o remetente.
- Destinatários, sempre com eco para o remetente:
  - `everyone`: todos no espaço. Entra no histórico (100 mensagens, em memória; perde no restart).
  - `nearby`: o conjunto `nearby` do remetente no último tick. Vazio → só o eco.
  - `direct`: o jogador `to`, se conectado; senão `chatError offline` (sem fila; id inexistente recebe a mesma resposta).
- `nearby` e `direct` nunca entram no histórico.
- Close 1008 (mensagem inválida): JSON inválido, tipo errado em qualquer campo, `cid` ausente, vazio, com mais de 36 caracteres ou fora de `[A-Za-z0-9_-]`.
- `chatError`, sem fechar a conexão, verificado nesta ordem (o primeiro que falhar responde):
  1. `invalid`: `scope` desconhecido ou ausente; `direct` sem `to` ou com `to` vazio; `to` presente fora de `direct`; `to` igual ao próprio id; `to` com mais de 300 bytes.
  2. `empty` / `too_long`: texto vazio depois da limpeza; mais de 500 runes (code points) ou mais de 20 linhas depois da limpeza. O servidor nunca trunca.
  3. `rate_limited`: token bucket do chat **por identidade**, 0,5/s com burst 5 (5 seguidas, depois 1 a cada 2 s), compartilhado por todas as conexões da identidade: reconectar não devolve tokens. Só mensagem que passou nas regras acima gasta token. O bucket geral de 20/s, por conexão, conta toda mensagem antes disso.
  4. `rate_limited` (só `everyone`): token bucket **por espaço**, 20/s com burst 40, somando todos os remetentes, para uma rajada não encher o buffer de envio de quem recebe. O token da identidade já foi gasto.
  5. `offline`: `direct` para quem não está conectado.
- Limpeza do texto, nesta ordem (o texto entregue é o limpo):
  1. UTF-8 inválido → U+FFFD.
  2. `\r\n`, `\r`, U+0085, U+2028, U+2029 → `\n`; `\t` e as letras em branco (U+115F, U+1160, U+3164, U+FFA0 — preenchimentos do hangul — e U+2800, braille vazio) → espaço, para texto feito só delas virar `empty`.
  3. Remove controles (`Cc`) exceto `\n` e formatação (`Cf`): bidi (U+202A–202E, U+2066–2069, U+200E/F, U+061C), BOM, soft hyphen, U+200B, tags U+E0000–E007F etc.
  4. Exceção: ZWJ (U+200D) e ZWNJ (U+200C) ficam quando a rune anterior existe e não é ASCII, espaço nem formatação, e a próxima rune que não seja ZWJ/ZWNJ existe e não é espaço; repetidos colapsam no primeiro. Preserva emoji compostos (👨‍👩‍👧, 🏳️‍🌈, tons de pele), bandeiras e o ZWNJ do persa.
  5. Remove espaços no fim de cada linha; mais de 3 `\n` seguidos viram 3; trim nas pontas. Sem normalização Unicode (NFC).
- O cliente exibe só como texto (`textContent`), nunca como HTML ou markdown. Pode espelhar a limpeza para contar caracteres, mas o servidor decide.
- O JSON do servidor não escapa `<`, `>` e `&` (sai literal, não `\u003c`); o cliente usa `JSON.parse` e nunca injeta o texto como HTML.
- O servidor nunca loga texto, `to` nem `cid`; só `chat rejected` com o motivo, em debug.

## Regras de movimento (servidor autoritativo)

1. A cada tick, para cada jogador com fila não vazia e cooldown expirado: consome 1 input.
2. Atualiza `dir` sempre.
3. Calcula destino. Fora do mapa ou tile bloqueado → não move (só vira). Caso contrário move.
4. Jogadores não colidem entre si.
5. `ack` = `seq` do input consumido (mesmo se bloqueado).
6. Inputs com `seq` <= último ack são ignorados.

## Mapa

- Arquivo: `maps/<mapId>.tmj` (Tiled JSON, orthogonal, finito). Servido em `GET /maps/<mapId>.tmj`. Fase 1: `mapId = "office"`.
- `tilewidth = tileheight = 32`. Tamanho do escritório: 40×25.
- Camadas obrigatórias:
  - `floor` (tilelayer)
  - `walls` (tilelayer) — qualquer gid ≠ 0 bloqueia
  - `spawns` (objectgroup) — objetos `point: true`; tile = `floor(x/32), floor(y/32)`
- Camada opcional `zones` (objectgroup): um retângulo (sem `point`, `ellipse`, `polygon`, `polyline`, `text` ou `gid`; `rotation` 0) por zona, até 255. O `name` nativo do objeto é o nome exibido (1–40 runes, não vazio); propriedades Tiled `string`: `id` (`[a-z0-9-]{1,32}`, único) e `kind` (`meeting` ou `private`). Tile na zona se o centro `(32x+16, 32y+16)` cai em `[x, x+width) × [y, y+height)`. O servidor recusa o mapa no boot se uma zona é inválida, tem `width`/`height` ≤ 0, não cobre nenhum tile, divide tile com outra, ou se um spawn cai numa zona.
- Tileset embutido no `.tmj`:

```json
{ "firstgid": 1, "name": "office", "image": "tiles.png",
  "tilewidth": 32, "tileheight": 32, "columns": 8, "tilecount": 8,
  "imagewidth": 256, "imageheight": 32 }
```

- Semântica dos gids (placeholder até tileset Kenney):

| gid | tile | camada típica |
|---|---|---|
| 1 | piso claro | floor |
| 2 | carpete (salas) | floor |
| 3 | parede | walls |
| 4 | mesa | walls |
| 5 | planta | walls |
| 6 | sofá | walls |
| 7 | piso de madeira (copa) | floor |
| 8 | quadro/tela | walls |

- O frontend gera a textura `tiles.png` em runtime (placeholder colorido); servidor nunca lê a imagem.

## Spawn e reconexão

- Identidade com última posição conhecida (memória do processo) → volta para ela. A memória guarda no máximo 1000 identidades ausentes; acima disso esquece a que saiu há mais tempo. Ao reentrar, a entrada é consumida.
- Senão → spawn point em ordem, ciclando.
