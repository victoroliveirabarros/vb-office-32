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

- Mensagem do cliente > 4 KiB ou inválida → close 1008.
- Rate limit por conexão: token bucket de 20 mensagens/s com burst 40. Conta toda mensagem recebida, inclusive inválida. Excedeu → close 1008 reason `"rate limit"`.
- Cliente lento (buffer de envio cheio, 64 mensagens) → close 1008 reason `"slow consumer"`.
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

## Servidor → Cliente

| `t` | `d` | Quando |
|---|---|---|
| `welcome` | `{ selfId: string, mapId: string, tickRate: number, stepMs: number, players: Player[] }` | Logo após conectar. `players` inclui o próprio. |
| `joined` | `Player` | Outro jogador entrou. |
| `left` | `{ id: string }` | Jogador saiu. |
| `state` | `{ tick: number, ack: number, players: Pos[] }` | Fim de tick em que houve mudança OU o `ack` do destinatário avançou. `players` = só quem mudou posição/direção no tick. `ack` = último `seq` processado do destinatário (0 se nenhum). |
| `pong` | `{ ts: number }` | Resposta a `ping`. |
| `media` | `{ url: string, token: string, expiresAt: number }` | Só com mídia configurada. Logo após `welcome` e reemitido a cada 5 min. `url` = URL WS do LiveKit; `token` = JWT de acesso (TTL 10 min); `expiresAt` = expiração do token em unix **ms**. |
| `nearby` | `{ ids: string[] }` | Só com mídia configurada. Logo após `media` (mesmo vazio) e no fim de todo tick em que o conjunto do destinatário mudou (depois do `state` desse tick, se houver). Conjunto audível completo, ordenado, sem o próprio. |

Ordem ao conectar com mídia: `welcome` → `media` → `nearby`; só então os outros recebem `joined`. Sem mídia configurada o servidor nunca envia `media` nem `nearby`; clientes antigos ignoram tipos desconhecidos.

## Proximidade (mídia)

- Distância euclidiana em tiles, em inteiros: `d² = dx² + dy²`.
- Par entra no conjunto com `d² ≤ 16` (4 tiles) e sai com `d² > 25` (5 tiles); `16 < d² ≤ 25` mantém o estado anterior (histerese).
- Simétrica: A está no conjunto de B ⇔ B está no de A. Paredes não bloqueiam.
- Calculada no tick: só posição conta (virar não muda nada). Jogador novo é avaliado no tick seguinte à entrada, por isso o primeiro `nearby` dele vem vazio; reconexão da mesma identidade mantém o conjunto. Quem sai é removido dos vizinhos, que recebem `nearby` no tick seguinte.
- Volume (cliente, fase 3b): 1,0 em `d ≤ 1`, linear até 0,2 em `d = 4`, 0,2 na faixa de histerese, 0 fora do conjunto.

### Token LiveKit

- JWT HS256 assinado com o segredo da API LiveKit. Claims: `iss` = API key, `sub` = ID do jogador, `name` = nome de exibição, `nbf`, `iat`, `exp`, `video`.
- `video`: `{"room":"<espaço>","roomJoin":true,"canPublish":true,"canPublishSources":["microphone","camera"],"canSubscribe":true,"canPublishData":false,"canUpdateOwnMetadata":false}`.
- O LiveKit renova sozinho o token de quem está conectado; o `media` novo só serve para um `connect` futuro. O cliente nunca reconecta a sala ao receber `media`.

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
