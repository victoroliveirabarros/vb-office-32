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
- Em qualquer modo, `?av=<compacta>` opcional escolhe a aparência ao entrar, aplicada antes do `welcome` (ver [Aparência](#aparência)). Ausente, vazia ou inválida → ignorada (nunca recusa o upgrade).
- Outra falha de autenticação → HTTP 401 com corpo genérico (`Unauthorized`), nunca o erro interno.
- Mesma identidade conectando de novo derruba a sessão anterior (close code 4001, reason `"replaced"`). Os outros só recebem `joined` se o nome ou a aparência mudou.
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
- Rate limit por conexão: token bucket de 20 mensagens/s com burst 40. Conta toda mensagem recebida, inclusive inválida. Excedeu → close 1008 reason `"rate limit"`. O chat e a aparência têm limites próprios, por identidade (e o chat também por espaço), que não fecham a conexão (ver [Chat](#chat) e [Aparência](#aparência)).
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
type Appearance = { skin: number; hair: number; hairColor: number; shirt: number; pants: number; acc: number }
type Player     = { id: string; name: string; x: number; y: number; dir: Dir; appearance: Appearance }
type Pos        = { id: string; x: number; y: number; dir: Dir }
```

`Player.appearance` vem sempre, com os seis campos (ver [Aparência](#aparência)).

## Cliente → Servidor

| `t` | `d` | Regra |
|---|---|---|
| `move` | `{ seq: number, dir: Dir }` | Intenção de 1 passo. `seq` uint32 crescente por conexão. Fila por jogador com cap `MaxPendingInputs` (8); excedente descartado. |
| `ping` | `{ ts: number }` | Servidor responde `pong` com mesmo `ts`. |
| `chat` | `{ cid: string, scope: Scope, to?: string, text: string }` | Ver [Chat](#chat). `cid` é do cliente, só para casar eco e erro. |
| `appearance` | `Appearance` | Pede nova aparência. Campos ausentes = 0; chaves desconhecidas ignoradas. Ver [Aparência](#aparência). |
| `deskInvite` | `{ target: string }` | Dono convida `target` para a própria mesa. Ver [Mesas](#mesas). |
| `deskRevoke` | `{ target: string }` | Dono remove o convite de `target`. Ver [Mesas](#mesas). |

## Servidor → Cliente

| `t` | `d` | Quando |
|---|---|---|
| `welcome` | `{ selfId: string, mapId: string, tickRate: number, stepMs: number, players: Player[] }` | Logo após conectar. `players` inclui o próprio. |
| `joined` | `Player` | Outro jogador entrou, ou reconectou derrubando a sessão anterior com nome ou aparência diferente (o cliente substitui o jogador de mesmo `id`). |
| `left` | `{ id: string }` | Jogador saiu. |
| `state` | `{ tick: number, ack: number, players: Pos[] }` | Fim de tick em que houve mudança OU o `ack` do destinatário avançou. `players` = só quem mudou posição/direção no tick. `ack` = último `seq` processado do destinatário (0 se nenhum). |
| `pong` | `{ ts: number }` | Resposta a `ping`. |
| `media` | `{ url: string, token: string, expiresAt: number }` | Só com mídia configurada. Logo após `welcome` e reemitido a cada ~5 min (verificação a cada 1 min, então entre 5 e 6 min). `url` = URL WS do LiveKit; `token` = JWT de acesso (TTL 10 min); `expiresAt` = expiração do token em unix **ms**. |
| `zone` | `{ id: string, name?: string, kind?: "meeting" \| "private" \| "desk" }` | Sempre, com ou sem mídia; só para o próprio jogador. Ao conectar (fora de zona: `{ id: "" }`) e no fim de todo tick em que o destinatário cruzou a borda de uma zona (depois do `state` e antes do `nearby` desse tick). Fora de zona só vai `id`, vazio. Ver [Zonas](#zonas). |
| `nearby` | `{ ids: string[] }` | Sempre, com ou sem mídia. Ao conectar (mesmo vazio) e no fim de todo tick em que o conjunto do destinatário mudou (depois do `state` e do `zone` desse tick, se houver). Conjunto completo de quem o destinatário ouve (ver [Proximidade](#proximidade) e [Zonas](#zonas)), ordenado, sem o próprio. |
| `chat` | `Chat` | Mensagem de chat para o destinatário, ou eco para o remetente (com `cid`). |
| `chatHistory` | `{ messages: Chat[] }` | Ao conectar, sempre (mesmo vazio): últimas ≤ 100 mensagens `everyone`, mais antiga primeiro, sem `cid`. |
| `chatError` | `{ cid: string, reason: "invalid" \| "empty" \| "too_long" \| "rate_limited" \| "offline" }` | Chat recusado; só para o remetente. |
| `appearance` | `{ id: string, appearance: Appearance }` | Resposta a todo `appearance` do cliente. Mudou → para todos (inclusive o remetente); sem mudança, fora do catálogo ou acima do limite → só para o remetente, com a aparência atual. |
| `desks` | `{ desks: Desk[] }` | Só em mapa com mesas. Ao conectar e, para todos os outros, quando o dono de uma mesa entra, sai ou muda de nome. Ver [Mesas](#mesas). |
| `deskGuests` | `{ desk: string, guests: { id: string, name: string, online: boolean }[] }` | Só para o dono online: ao conectar e a cada convite, revogação, entrada ou saída de convidado. `guests` ordenado por `id`. |
| `deskInvite` | `{ desk: string, owner: string, ownerName: string, invited: boolean }` | Só para o convidado: ao ser convidado (`true`), ao perder o convite (`false`) e, ao conectar, um por convite ativo. |

Ordem ao conectar: `welcome` → `media` (só com mídia) → `zone` → `desks` (só em mapa com mesas) → `deskGuests` (só para o dono) → `deskInvite` (um por convite ativo) → `nearby` → `chatHistory`; só então os outros recebem `joined` e, se o dono de uma mesa ficou online, `desks`. Ao sair: `left` → `desks` (se era dono). O `?av=` já vale no `welcome` e no `joined`, sem `appearance` à parte. Ordem no fim de um tick: `state` → `zone` → `nearby`. Sem mídia configurada o servidor nunca envia `media`. Clientes antigos ignoram tipos desconhecidos.

## Proximidade

- Distância euclidiana em tiles, em inteiros: `d² = dx² + dy²`.
- Par entra no conjunto com `d² ≤ 16` (4 tiles) e sai com `d² > 25` (5 tiles); `16 < d² ≤ 25` mantém o estado anterior (histerese).
- Simétrica: A está no conjunto de B ⇔ B está no de A. Paredes não bloqueiam.
- Vale para mídia e para o chat `nearby`. Calculada no tick: só posição conta (virar não muda nada). Jogador novo é avaliado no tick seguinte à entrada, por isso o primeiro `nearby` dele vem vazio; reconexão da mesma identidade mantém o conjunto. Quem sai é removido dos vizinhos, que recebem `nearby` no tick seguinte.
- Essa regra só vale entre dois jogadores fora de zonas; com zona, vale [Zonas](#zonas).
- Volume (cliente, fase 3b): 1,0 em `d ≤ 1`, linear até 0,2 em `d = 4`, 0,2 na faixa de histerese, 0 fora do conjunto.

## Zonas

- Retângulos da camada `zones` do mapa (ver [Mapa](#mapa)), de tipo `meeting` (sala de reunião), `private` (sala privada, ringue) ou `desk` (estação de trabalho, ver [Mesas](#mesas)). Um tile pertence à zona se o centro dele cai no retângulo; zonas nunca dividem tiles.
- Quem está numa zona ouve e é ouvido por todos da mesma zona, a qualquer distância, e por ninguém de fora, nem colado na porta. Fora de zonas vale a [Proximidade](#proximidade), só entre quem também está fora.
- Mudança de zona é imediata no tick em que o jogador cruza a borda: sem histerese, e quem sai de uma zona não herda a histerese da distância (dois que saem juntos a `d² = 25` não ficam no conjunto).
- O jogador recebe `zone` com a zona em que está ao conectar e a cada mudança; a zona dos outros não vai no protocolo (o cliente deriva das posições e do mapa, ambos públicos — presença por sala não é segredo).
- O chat `nearby` herda a regra: dentro de uma zona chega só a quem está nela.

### Mesas

- Zona `kind: "desk"`, uma por estação (`mesa-01`…`mesa-12`): fileira da cadeira + fileira da mesa, 3×2 tiles. Isola como as outras zonas.
- Mesa sem dono configurado (`VB_OFFICE32_DESKS_FILE`/`VB_OFFICE32_DESKS`) é aberta a todos. Mesa com dono só deixa entrar o dono e os convidados dele: o passo para um tile dela é recusado como tile bloqueado (vira, `ack` avança, posição igual). Dono offline (passada a carência) → só o dono entra.
- `Desk`: `{ id: string, owner?: { id?: string, name: string }, online: boolean, locked: boolean }`. `locked` = tem dono, igual para todos os destinatários ("fechada para mim" é derivado no cliente). `owner` só em mesa com dono; `owner.id` depois que o dono conectou neste processo; `owner.name` = nome da sessão se online, senão o nome configurado, o da última sessão ou o da zona.
- Dono: identidade cujo e-mail verificado está na configuração (em modo guest, o nome igual à parte local do e-mail). Se outra identidade já é dona online, quem chega entra sem mesa. Dono que conecta pela primeira vez (não substituição nem volta na carência) nasce no assento: o tile andável da zona mais perto do centro (empate: menor `y`, depois menor `x`).
- Convite por identidade, até 20 por mesa; o alvo precisa estar online; repetido não faz nada. Sobrevive à desconexão do convidado. Termina com `deskRevoke` (alvo online ou não) ou quando o dono fica offline por mais de 30 s (carência própria da mesa, com ou sem mídia); a volta do dono dentro do prazo mantém os convidados.
- Convidado dentro da mesa ao perder o convite: o servidor o move para o tile livre fora de zonas mais perto a pé. Mesma rodada: `deskInvite { invited: false }` ao alvo e `deskGuests` ao dono; no tick seguinte (≤ 50 ms) `state` (posição nova, `ack` = último `seq` recebido, inputs pendentes descartados), `zone { id: "" }` e `nearby`.
- `deskInvite`/`deskRevoke` com JSON malformado ou `target` que não é string → close 1008. `target` vazio, maior que 300 bytes, o próprio remetente, desconhecido, remetente sem mesa ou que não é o dono online → ignorado em silêncio. Rate limit por identidade como o chat (0,5/s, burst 5), além do bucket geral.

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

## Aparência

- `Appearance` escolhe uma opção por categoria: `skin` (pele), `hair` (estilo do cabelo), `hairColor`, `shirt`, `pants`, `acc` (acessório; 0 = nenhum). Cada campo é um índice inteiro 0–255 no catálogo `internal/avatar` (fonte única; `web/src/avatar/catalog.gen.ts` é gerado dele). Hoje: 5 peles, 7 estilos (6 = careca, sem cor de cabelo visível), 8 cores de cabelo, 8 camisas, 4 calças, 4 acessórios.
- O catálogo só cresce no fim: nada é removido nem reordenado, então um índice salvo mantém o significado. O cliente troca índice que não conhece por 0 ao desenhar.
- Forma compacta (`?av=` e `localStorage`): `"skin.hair.hairColor.shirt.pants.acc"` em decimal, ex. `"2.0.5.1.3.0"`. Campos finais ausentes = 0 (`"2.0"` = `"2.0.0.0.0.0"`); vazia, mais de 6 campos, campo que não é decimal 0–255 ou fora do catálogo → inválida.
- Padrão (sem escolha nem memória): derivado do `id`, estável e calculado só pelo servidor — FNV-1a 64 do `id` lido como número em base mista, um dígito por campo na ordem acima, sobre pools congelados (`skin` 0–4, `hair` 0–5, `hairColor` 0–6, `shirt` 0–7, `pants` 0–3, `acc` `[0,0,0,1]`). Crescer o catálogo não muda o padrão de ninguém.
- Ao conectar vale, nesta ordem: `?av=` válido → aparência lembrada da identidade → padrão. A memória é a mesma da última posição (ver [Spawn e reconexão](#spawn-e-reconexão)).
- C→S `appearance`:
  - Close 1008 (mensagem inválida): `d` que não é objeto (inclusive `null`) ou campo com tipo errado, negativo, fracionário, em notação exponencial ou > 255. `null` num campo conta como ausente.
  - Índice fora do catálogo → sem close: só o remetente recebe `appearance` com a atual (log em debug).
  - Rate limit **por identidade**, 0,2/s com burst 3 (3 seguidas, depois 1 a cada 5 s), compartilhado por todas as conexões da identidade: reconectar não devolve tokens. Só pedido dentro do catálogo gasta token, mesmo igual à atual. Excedeu → sem close: só o remetente recebe `appearance` com a atual. O bucket geral de 20/s, por conexão, conta toda mensagem antes disso.
  - Válido e diferente da atual → guarda e envia `appearance` a todos, inclusive o remetente. Igual à atual → só o remetente recebe.

## Regras de movimento (servidor autoritativo)

1. A cada tick, para cada jogador com fila não vazia e cooldown expirado: consome 1 input.
2. Atualiza `dir` sempre.
3. Calcula destino. Fora do mapa, tile bloqueado ou tile de outra zona fechada para o jogador ([Mesas](#mesas)) → não move (só vira). Caso contrário move.
4. Jogadores não colidem entre si.
5. `ack` = `seq` do input consumido (mesmo se bloqueado).
6. Inputs com `seq` <= último ack são ignorados.

## Mapa

- Arquivo: `maps/<mapId>.tmj` (Tiled JSON, orthogonal, finito). Servido em `GET /maps/<mapId>.tmj`. Fase 1: `mapId = "office"`.
- `tilewidth = tileheight = 32`. Tamanho do escritório: 50×25 (até a fase 6.1, 40×25).
- Camadas obrigatórias:
  - `floor` (tilelayer)
  - `walls` (tilelayer) — qualquer gid ≠ 0 bloqueia
  - `spawns` (objectgroup) — objetos `point: true`; tile = `floor(x/32), floor(y/32)`
- Camada opcional `decor` (tilelayer): arte sem colisão (cadeiras, monitores, quadros), desenhada acima de `walls`; o servidor a ignora.
- Camada opcional `zones` (objectgroup): um retângulo (sem `point`, `ellipse`, `polygon`, `polyline`, `text` ou `gid`; `rotation` 0) por zona, até 255. O `name` nativo do objeto é o nome exibido (1–40 runes, não vazio); propriedades Tiled `string`: `id` (`[a-z0-9-]{1,32}`, único) e `kind` (`meeting`, `private` ou `desk`). Tile na zona se o centro `(32x+16, 32y+16)` cai em `[x, x+width) × [y, y+height)`. O servidor recusa o mapa no boot se uma zona é inválida, tem `width`/`height` ≤ 0, não cobre nenhum tile ou nenhum tile andável, divide tile com outra, ou se um spawn cai numa zona.
- Camada opcional `areas` (objectgroup): retângulos com nome e propriedade `id`, como os de `zones` mas sem `kind`, que nomeiam partes do piso aberto (`copa`, `escritorio`) para as listas do cliente; o servidor a ignora e ela não muda áudio nem chat.
- Tileset embutido no `.tmj` (`name: "office"`), atlas `web/public/game/office-tiles.png` de tiles 32 px com 1 px de borda repetida (`margin: 1`, `spacing: 2`, 16 colunas). Mapa e atlas são gerados por `tools/officeart` (`make art`) a partir de uma planta ASCII; o gid só indexa a arte, a colisão é apenas `walls` ≠ 0. O servidor nunca lê a imagem.

## Spawn e reconexão

- Identidade com última posição conhecida (memória do processo) → volta para ela, com a mesma direção e aparência. A memória guarda no máximo 1000 identidades ausentes; acima disso esquece a que saiu há mais tempo (posição e aparência juntas). Ao reentrar, a entrada é consumida. Reconexão que derruba a sessão anterior mantém posição e aparência (salvo `?av=` válido).
- Senão → spawn point em ordem, ciclando.
- Dono de mesa: ver [Mesas](#mesas) (assento na primeira conexão; posição lembrada dentro de mesa fechada para a identidade → tile livre fora mais perto).
