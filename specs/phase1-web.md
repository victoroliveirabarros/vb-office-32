# Fase 1 — Frontend (web/)

Contrato: `specs/phase1-protocol.md` (obrigatório ler antes).

## Contexto

Projeto novo. Backend Go está sendo implementado em paralelo por outro agente em `internal/`, `cmd/`, `maps/` — **não tocar nesses diretórios**. Trabalhar somente em `web/`.

O backend serve `/ws` e `/maps/office.tmj` em `localhost:8080`. Enquanto ele não existe, compilar e testar a lógica pura sem servidor.

## User story

Como colega de time, abro o escritório no browser, informo meu nome, vejo o mapa em pixel art, ando com setas/WASD e vejo os outros andando suavemente.

## Escopo

Dentro:
- Vite + TypeScript (`strict`) + Phaser (última versão estável no npm — confirmar com `npm view phaser version`) + Vitest
- Tela de entrada (nome) em overlay HTML simples; nome lembrado em `localStorage` (try/catch)
- Cena de boot: gera textura placeholder do tileset (8 tiles 32×32, cores distintas por gid conforme contrato) e textura de avatar; carrega `/maps/office.tmj`
- Cena do escritório: renderiza `floor` e `walls`, avatares com nome acima, câmera segue jogador local, zoom adequado para pixel art
- Rede: cliente WS tipado com reconexão (backoff exponencial com jitter, máx. 10 s); trata close 4001 mostrando "sessão aberta em outra aba" sem reconectar
- Jogador local: **predição + reconciliação**
- Jogadores remotos: **interpolação** (tween entre tiles na duração de `stepMs`)
- Indicador simples de latência (ping a cada 2 s, `pong`)

Fora: chat, áudio/vídeo, SSO, assets Kenney finais, UI elaborada.

## Padrões de código (do usuário — obrigatório)

- Código organizado, **comentários mínimos** (só intenção não óbvia).
- Tipos do protocolo num único módulo, espelhando o contrato exatamente.
- Lógica pura separada de Phaser para ser testável (predição/reconciliação, colisão, parsing de mensagens).
- Sem `any`. Sem dependências além de `phaser`, `vite`, `typescript`, `vitest`.

## Estrutura sugerida

```
web/
  index.html
  package.json            scripts: dev, build (tsc --noEmit && vite build), test (vitest run), typecheck
  tsconfig.json
  vite.config.ts          proxy /ws (ws: true) e /maps → http://localhost:8080
  src/
    main.ts
    net/protocol.ts       tipos + guards de mensagem
    net/connection.ts     WS tipado, eventos, reconexão
    game/grid.ts          colisão a partir do .tmj (walls ≠ 0 bloqueia, borda bloqueia)
    game/prediction.ts    fila de inputs pendentes, aplica local, reconcilia com ack
    game/prediction.test.ts
    game/grid.test.ts
    scenes/BootScene.ts
    scenes/OfficeScene.ts
    entities/Avatar.ts
    ui/join.ts
```

## Predição e reconciliação

- Tecla pressionada → a cada `stepMs` envia `move {seq, dir}` e aplica localmente se `grid` permitir (sempre atualiza dir).
- Guarda pendentes `{seq, dir}`.
- Ao receber `state` com `ack`: descarta pendentes `seq <= ack`; posição autoritativa do próprio jogador = valor do `state` se presente, senão a última autoritativa conhecida; reaplica pendentes restantes sobre ela. Se resultado divergir do exibido → corrige (snap se distância > 1 tile, tween caso contrário).
- Testes Vitest cobrindo: sem divergência, colisão divergente do servidor, ack parcial, ack com posição ausente no state.

## Critérios de aceite

- `npm run build` e `npm test` verdes em `web/`.
- `npm run dev` com backend rodando: dois navegadores veem um ao outro andar; parede bloqueia; movimento do próprio jogador sem atraso perceptível; remoto suave.
- Close 4001 mostra aviso e não reconecta; queda de rede reconecta sozinho.
- Renderização nítida (`pixelArt: true`, `roundPixels`), funciona redimensionando janela.

## Entrega

Relatar: árvore de `web/`, comandos rodados e saídas resumidas, versão do Phaser usada, desvios do spec e por quê.
