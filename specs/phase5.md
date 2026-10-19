# Fase 5 — Zonas privadas e compartilhamento de tela

Base: fases 1–4 (`phase1-protocol.md`, `phase3.md`, `phase4.md`, `security-hardening.md`), `backlog.md`. Mesmos padrões: Go idiomático, stdlib, comentários mínimos, TS sem `any`. Repositório público.

## Contexto

- Hoje a área aberta é "pública": o servidor decide quem está perto, mas um cliente modificado consegue assinar qualquer trilha da sala LiveKit (`canSubscribe` vale para a sala toda).
- Salas de reunião existem no mapa só como desenho (carpete); não isolam nada.
- Custo: egress do SFU é o custo dominante; compartilhamento de tela é o fluxo mais caro.

## Complexidade

Score 15 (complexo): mudança de regra de proximidade, enforcement de privacidade na mídia, nova fonte de publicação (tela), mapa, UI.

## User story

Como colega, entro numa sala de reunião e só quem está dentro me ouve e vê — de fora ninguém escuta, mesmo perto da porta. Lá dentro, compartilho minha tela com quem está na sala.

## Escopo

### A. Zonas no mapa

- Nova camada `zones` (objectgroup) no `.tmj`: retângulos com propriedades `id` (string), `name` (exibição) e `kind`:
  - `meeting`: sala de reunião (compartilhamento de tela permitido).
  - `private`: cabine/área privada (sem tela).
- Tile pertence à zona se o centro do tile está dentro do retângulo. Zonas não se sobrepõem (validação no load).
- Atualizar `maps/office.tmj`: as 2 salas de reunião viram `meeting`; adicionar 1–2 cabines `private`.

### B. Regra de audição (servidor, puro)

- Jogador **dentro** de uma zona ouve/é ouvido por **todos da mesma zona**, independentemente da distância, e por ninguém de fora.
- Jogador **fora** de zonas: regra de proximidade atual (entra ≤ 4, sai > 5), considerando só quem também está fora de zonas.
- Mudança de zona é imediata (sem histerese) ao cruzar a borda.
- `nearby` continua sendo o conjunto audível (agora inclui a regra de zona) — chat "Perto" herda a mesma privacidade.
- Mensagem nova `zone` (servidor → cliente): `{ id, name, kind }` ao entrar, `{ id: "" }` ao sair; enviada só ao próprio jogador. Presença por zona para outros? (decidir no refinamento: mostrar quem está em cada sala na lista de presentes?)

### C. Enforcement de privacidade na mídia

Objetivo: quem não está no conjunto audível **não consegue** assinar as trilhas, mesmo com cliente modificado.

- Opção recomendada (validar no refinamento): **permissões de assinatura do publicador** (`setTrackSubscriptionPermissions(allowAll: false, [{participantIdentity, allowAll: true}...])`) atualizadas pelo cliente a cada `nearby`. O SFU aplica a regra; um assinante malicioso não a contorna. Um publicador malicioso só expõe a si mesmo.
- Alternativa: sala LiveKit separada por zona (troca de sala ao entrar/sair; reconexão de ~1 s). Avaliar custo/latência vs. permissões.
- Corrida na entrada (permissão chega depois do `nearby`): avaliar se assinatura fica "not allowed" momentaneamente e como o cliente se recupera.

### D. Compartilhamento de tela

- Grant passa a incluir `screen_share` (e `screen_share_audio`? decidir) em `canPublishSources`.
- UI só oferece "Compartilhar tela" dentro de zona `meeting`; ao sair da zona, para o compartilhamento automaticamente.
- Servidor: se o cliente publicar tela fora de `meeting`… (decidir no refinamento: tolerar, pois permissões já restringem quem vê; ou remover a trilha via admin `MutePublishedTrack`).
- Qualidade/custo: preset baixo (ex.: 720p a 5–15 fps, bitrate limitado), simulcast/camadas se o SDK suportar para tela; quem assiste vê em destaque (tile grande); 1 compartilhamento por sala por vez? (decidir).
- Assinatura de tela só para membros da mesma zona (respeita C).

### E. Cliente

- Indicação visual da zona atual ("Sala 1 — reunião privada") e borda/overlay sutil das zonas no mapa.
- Lista de presentes/chat: marcar quem está na mesma sala.
- Tile grande para tela compartilhada; botão "Parar".

## Fora

- Paredes bloqueando som na área aberta, salas com senha/convite, gravação, moderação, persistência.

## Critérios de aceite

- Dentro de uma sala, todos se ouvem; de fora, ninguém ouve, inclusive colado na porta; quem está dentro não ouve quem está fora.
- Cliente modificado fora da sala não consegue assinar trilhas de quem está dentro (validado contra LiveKit real).
- Chat "Perto" dentro da sala chega só aos membros da sala.
- Tela compartilhada visível só para quem está na mesma sala de reunião; para ao sair.
- `go vet`, `go test -race`, staticcheck, govulncheck, `npm test`, `npm run build` verdes; loadbot sem regressão.

---

# Refinamento técnico (vence o texto acima em caso de conflito)

Fontes conferidas em 2026-10-19: livekit-client 2.23.0 (`web/node_modules`), livekit-server v1.13.10, livekit/protocol.

## Divisão

- **5a — servidor, mapa, protocolo** (vai a produção sozinho: clientes atuais ignoram `zone`; audição e chat já isolados para clientes honestos).
- **5b — mídia:** permissões do publicador, grant `screen_share`, `Permissions-Policy`, tela/palco, volume na zona, harness de integração.
- **5c — UI e extras da 4c:** overlay/faixa de zona, rótulos chat/presentes, DM por clique no avatar, fechar abas de DM, desambiguação de nomes.

## Decisão central: privacidade por permissões do publicador

- `setTrackSubscriptionPermissions(false, [{participantIdentity, allowAll: true}, ...])` com o conjunto `nearby`. O SFU aplica: assinatura sem permissão dá `not_allowed` (servidor guarda o desejo e conclui quando liberar); revogação fecha a DownTrack na hora; `allowAll` cobre trilhas publicadas depois (tela incluída); permissões persistem no resume e são reenviadas pelo SDK no restart antes de republicar; indicador de fala filtrado por assinatura.
- Salas separadas por zona **descartadas** (`MoveParticipant` não existe no OSS → reconexão de 0,5–1,5 s a cada porta; N salas para webhook/reconciliação). `UpdateSubscriptions`/`UpdateParticipant` não dão regra por par.
- **Nunca emitir grant `recorder`** (ignora revogação).
- Cliente modificado: assinante vê lista de participantes/publicações, mas não recebe mídia nem fala; publicador modificado só se expõe. Presença por sala é pública (posições + mapa público) — documentar.

## 5a — decisões

- `tilemap`: `Zone{ID, Name; Kind ("meeting"|"private"); Rect}`, `Map.Zones`, índice por tile (`zoneAt []uint8`, 0 = fora), `ZoneAt(p)`. Tile na zona se o centro cai em `[ox, ox+w) × [oy, oy+h)`. Camada `zones` opcional; se existir, `objectgroup`. Nome = `name` nativo do objeto; `id` e `kind` de propriedades Tiled. Erros no load: não-retângulo (point/ellipse/polygon/polyline/text) ou `rotation != 0`; w/h ≤ 0; `id` fora de `[a-z0-9-]{1,32}` ou duplicado; `kind` inválido; nome vazio ou > 40 runes; zona sem tiles; sobreposição; spawn em zona.
- `world`: `player.zone` (índice) atualizado no `Join` e no movimento antes do `stepNear`. `audible(a, b, was)`: se algum está em zona → `a.zone == b.zone`; senão `near(d2, was)`. Sem histerese em zona; sair de zona não herda histerese. `Delta.Zones map[string]string` (só quem mudou), `Space.Zone(id)`. Substituição descarta mudança de zona pendente.
- Protocolo `zone` (S→C, só ao próprio): `{id, name, kind}`; fora: `{id: ""}`. Join: `welcome` → `media`(se) → **`zone` (sempre)** → `nearby` → `chatHistory` → `joined`. Tick: `state` → `zone` (alterados) → `nearby`. Enviado também sem mídia. Zona dos outros não vai no protocolo (derivável no cliente).
- Chat `nearby` herda via `space.Nearby` — só teste novo (mensagem de dentro não chega à porta).
- `office.tmj`: Salas 1 e 2 `meeting` (retângulos (32,32,320,256) e (384,32,320,256) — conferir com o desenho), cabine `private` em x=23..28, y=1..8 fechando a linha 9 com porta em x=25..26 (ajustar ao mapa real); portas fora das zonas.
- Testes: tilemap (todas as validações + `office.tmj` com 2 meeting e ≥ 1 private), `audible` table-driven (borda, porta d²=1 não ouve, mesma zona d²=80 ouve, entrar/sair), `Delta.Zones`, random walk com zonas, benchmark sem regressão, realtime (ordem do join, `zone` antes de `nearby`, chat isolado, sem mídia).

## 5b — decisões

- Grant: `canPublishSources: ["microphone","camera","screen_share"]` (sem `screen_share_audio`). Atualizar teste do JSON exato.
- `Permissions-Policy`: `display-capture=(self)` (hoje `()` bloqueia `getDisplayMedia`).
- Permissões no cliente: dedupe; `setTrackSubscriptionPermissions(false, [])` logo após `new Room` e de novo após `connect()` resolver e **antes** de `applyDevices()`; a cada `nearby`; **zerar** em `welcome` e quando o WS não está `open`. `not_allowed` não é erro (debug se > 3 s).
- Tela: `setScreenShareEnabled(on, {resolution: ScreenSharePresets.h720fps5.resolution, contentHint: 'detail', audio: false, systemAudio: 'exclude', selfBrowserSurface: 'exclude', surfaceSwitching: 'include'}, {screenShareEncoding: ScreenSharePresets.h720fps5.encoding})`; camada 360p padrão (dynacast pausa). Custo ~0,2–0,8 Mbit/s por assinante.
- Política: botão só com `kind === meeting` e conectado; `zone` não-meeting → `setScreenShareEnabled(false)`; assinante só assina tela se está em meeting e publicador em `nearby`; no máximo 1 tela assinada (mantém atual, senão menor identidade); UI desabilita botão se alguém da zona já compartilha. Parada pelo navegador: `LocalTrackUnpublished` com `ScreenShare` → estado off; cancelar seletor (`NotAllowedError`) → off sem erro.
- Servidor tolera tela fora de sala (fica sem assinantes, egress zero). Endurecimento via webhook `track_published` + `UpdateParticipant` (permissão completa) → backlog.
- `MediaRoom`: `setAllowedSubscribers(ids)`, `setScreenShareEnabled(on)`; `Publication.source`; `RemoteMedia`/`unsubscribed` com `source`; listener `screenEnded()`. `sync` separa mic, câmera (top-8) e tela (0/1). **Volume 1,0 dentro da mesma zona.**
- Lógica pura: `media/permissions.ts`, `media/screen.ts` (`canShare`, `screenTarget`, `shouldStop`).
- UI: palco `#media-stage` para tela; botões "Compartilhar tela"/"Parar".
- Integração: harness dev-only `web/e2e/intruder.html` (fora do build) em Chrome headless — intruso com `autoSubscribe:true` na porta: `not_allowed`, sem `TrackSubscribed`, `bytesReceived == 0`; ao entrar: `TrackSubscribed` ≤ ~1 s; ao sair: `TrackUnsubscribed`. Medir latências e registrar em `docs/livekit.md` (remover "private rooms come with zones as separate LiveKit rooms").

## 5c — decisões

- `web/src/game/zones.ts` (parse do `.tmj` espelhando o Go, só UI); overlay e borda sutis + nome da sala no Phaser; faixa no HUD ("Sala 1 — reunião privada").
- Dentro de zona: rótulo "na sala" no lugar de "perto"; aba "Perto" vira nome da sala com aviso "visível só para quem está na sala".
- DM por clique no avatar (pointer → `openDirect`), `ChatState.closeTab`, sufixo derivado do id só quando houver nomes repetidos.
