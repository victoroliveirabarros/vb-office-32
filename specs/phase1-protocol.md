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

- WebSocket em `GET /ws?name=<nome>` (auth stub da fase 1).
- `name`: 1–24 chars, `[A-Za-z0-9 _-]`, trim de espaços. Inválido → HTTP 400 antes do upgrade.
- Identidade = `"guest:" + lowercase(name)`. Mesma identidade conectando de novo derruba a sessão anterior (close code 4001, reason `"replaced"`).
- Todas mensagens são texto JSON com envelope:

```json
{ "t": "<tipo>", "d": { ... } }
```

- Mensagem do cliente > 4 KiB ou inválida → close 1008.
- Cliente lento (buffer de envio cheio, 64 mensagens) → close 1008 reason `"slow consumer"`.

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

- Identidade com última posição conhecida (memória do processo) → volta para ela.
- Senão → spawn point em ordem, ciclando.
