# Fase 3 — Áudio e vídeo por proximidade (LiveKit)

Base: fases 1–2 (`phase1-protocol.md`, `phase2.md`), `backlog.md`. Mesmos padrões: Go idiomático, stdlib primeiro, comentários mínimos, TS sem `any`. Repositório público: nada específico da empresa.

## Contexto

- Mídia via **LiveKit self-hosted** (Apache 2.0, SFU em Go). O LiveKit transporta áudio/vídeo; **o servidor Go decide quem ouve quem**.
- Produção (fork da empresa): LiveKit em ECS sobre EC2, rede host, Elastic IP, UDP. Não há precedente na empresa — o módulo de infra (Pulumi) vive no repo de infra da empresa, **fora deste repositório**. Aqui entra só documentação genérica e config de exemplo.
- Custo dominante é egress do SFU (ver análise inicial): vídeo pequeno por padrão, adaptive stream e dynacast ligados.

## Complexidade

Score 15 (complexo): 6+ arquivos, deps novas (SDK cliente LiveKit; talvez SDK Go), integração externa nova, regras de proximidade, risco médio-alto (mídia, permissões de dispositivo, custo).

## User story

Como colega, ao me aproximar de alguém no mapa passo a ouvi-lo e vê-lo (vídeo pequeno), com volume caindo pela distância; ao me afastar, a conversa some. Posso mutar microfone e desligar câmera.

## Escopo

### A. Proximidade (servidor, puro)

- `internal/world`: função pura de proximidade sobre posições. Regra inicial:
  - Distância euclidiana em tiles.
  - Entra no conjunto audível com `d ≤ 4`; sai com `d > 5` (histerese contra flapping).
  - Simétrica (A ouve B ⇔ B ouve A).
  - Paredes **não** bloqueiam nesta fase (zonas/salas na fase 5).
- Calculada no tick; só gera evento quando o conjunto de alguém muda.

### B. Protocolo (atualizar `phase1-protocol.md`)

- `media` (servidor → cliente), após `welcome` quando mídia habilitada: `{ url, token, expiresAt }`. Renovado antes de expirar (reemitido pelo servidor).
- `nearby` (servidor → cliente): `{ ids: string[] }` — conjunto audível completo do destinatário, enviado quando muda.
- Volume pela distância calculado **no cliente** a partir das posições que ele já recebe (1.0 em `d ≤ 1`, linear até 0.2 em `d = 4`, 0 fora do conjunto).
- Sem mídia configurada: servidor não envia `media`/`nearby`; cliente funciona como hoje.

### C. Tokens LiveKit (servidor)

- Envs: `VB_OFFICE32_LIVEKIT_URL` (URL pública WS do LiveKit), `VB_OFFICE32_LIVEKIT_API_KEY`, `VB_OFFICE32_LIVEKIT_API_SECRET` (segredo). Todas ou nenhuma (parcial → erro no boot citando a env).
- Token JWT de acesso LiveKit por sessão: identity = ID do jogador (`oidc:<sub>`/`guest:<nome>`), name = nome de exibição, room = id do espaço, grants: `roomJoin`, `canPublish` (fontes: microfone e câmera), `canSubscribe`, sem `canPublishData`, sem `canUpdateOwnMetadata`, sem admin. TTL curto (ex.: 1 h) com renovação via `media`.
- Preferir emissão com stdlib (JWT HS256) se o formato de grants for estável e simples; caso contrário usar o pacote oficial — decisão do refinamento.

### D. Cliente (web)

- `livekit-client` (SDK oficial). Conectar ao receber `media`; `autoSubscribe: false`, `adaptiveStream: true`, `dynacast: true`.
- Assinar trilhas só de quem está em `nearby`; desassinar ao sair.
- Volume por participante conforme distância (atualizado ao mover).
- Publicar microfone ao entrar (com permissão); câmera **desligada por padrão**, opt-in, publicada com simulcast e resolução baixa (bolha ~180p).
- UI mínima: faixa superior com tiles de vídeo dos próximos (só quem tem câmera ligada), indicador de fala no avatar (anel/ícone), botões mic/câmera no HUD, estado de permissão negada/sem dispositivo.
- Lógica pura separada e testável (diferença de conjuntos para subscribe/unsubscribe, curva de volume).
- Reconexão: se LiveKit cair, tenta de novo sem afetar o WS do jogo; token expirado → aguarda novo `media`.

### E. Dev local

- LiveKit em modo dev via Docker (`livekit/livekit-server --dev`, chave `devkey`/`secret`), alvo `make livekit` e integração no `make dev-oidc` (ou alvo próprio). `.env.example` com as envs LiveKit de dev.
- Funciona com devidp (fase 2) e com guest.

### F. Documentação de produção (genérica)

- `docs/livekit.md`: requisitos de rede (UDP mux numa porta, TCP fallback, TURN/TLS 443 opcional), `use_external_ip`/IP público estável, rede host, por que não atrás de LB comum, sinalização via proxy TLS, chave/segredo compartilhados com o app, custo (egress, simulcast, câmera opt-in), métricas a observar. Exemplo de `livekit.yaml` mínimo. Sem nomes/hosts/contas da empresa.

## Fora

- Zonas/salas privadas e compartilhamento de tela (fase 5), chat (fase 4).
- Enforcement de assinatura pelo servidor na área aberta (área aberta = "pública", como escritório real); isolamento forte vem com zonas como salas LiveKit separadas.
- Webhooks LiveKit, gravação, métricas Prometheus.
- Módulo Pulumi/ECS (repo de infra da empresa).

## Critérios de aceite

- Dois usuários a ≤ 4 tiles se ouvem; a > 5 não; entre 4 e 5 mantém estado anterior.
- `nearby` só é enviado quando o conjunto muda; teste table-driven da proximidade com histerese e simetria.
- Token LiveKit validado contra o servidor LiveKit dev real (conecta, publica, assina).
- Sem envs LiveKit: tudo da fase 2 funciona igual; nenhuma mensagem `media`.
- Config parcial de LiveKit falha no boot citando a env, sem ecoar segredo.
- Câmera desligada por padrão; ligar publica com simulcast; desligar despublica.
- Volume cai com a distância (teste da curva).
- `go vet`, `go test -race`, staticcheck, govulncheck, `npm test`, `npm run build` verdes; loadbot sem regressão.

---

# Refinamento técnico (vence o texto acima em caso de conflito)

Versões conferidas em 2026-10-18: livekit-server v1.13.10 (imagem `livekit/livekit-server:v1.13`), livekit-client 2.23.0 (ESM).

## Divisão

- **3a — servidor, protocolo, tokens, dev, docs** (pode ir a produção sozinho: cliente atual ignora mensagens novas).
- **3b — cliente e UI** (SDK, assinaturas, volume, botões, tiles, fala, autoplay, permissões, reconexão).

## 3a — decisões

### Proximidade (`internal/world/proximity.go`)
- Inteiros, sem raiz: entra `d² ≤ 16`; sai `d² > 25`; `16 < d² ≤ 25` mantém estado. `near(d2, was) bool`.
- Estado por par em adjacência simétrica `near map[string]map[string]struct{}`.
- `Join` marca id como pendente (avaliado no próximo `Step`); substituição não muda nada. `Leave` remove de todos os vizinhos e marca-os alterados.
- `Step`: para cada jogador em (movidos ∪ pendentes): remove vizinhos com `d² > 25`, adiciona jogadores com `d² ≤ 16`. Troca de direção não afeta.
- `Delta.Nearby map[string][]string` (só ids cujo conjunto mudou; listas ordenadas, sem o próprio). `Space.Nearby(id) []string`.
- Testes: tabela de `near` (16 entra; 17/18/20/25 mantém; 26 sai), simetria, sem evento sem mudança, leave notifica vizinhos, join no próximo Step, direção sem efeito; `BenchmarkStepProximity200`.

### Token (`internal/media`)
- **Stdlib** HS256 (sem `livekit/protocol` nem server-sdk-go — grafo pesado). Header `{"alg":"HS256","typ":"JWT"}`, base64url sem padding, HMAC com **bytes crus** do segredo.
- Claims: `iss`=api key, `sub`=identity, `name`, `nbf`, `iat`, `exp`, `video`.
- Grants exatos (bools **sem** omitempty): `{"room":"office","roomJoin":true,"canPublish":true,"canPublishSources":["microphone","camera"],"canSubscribe":true,"canPublishData":false,"canUpdateOwnMetadata":false}`. `canPublishData:false` explícito (ausente herda `canPublish`).
- **TTL 10 min, reemitido a cada ~5 min** (na primeira verificação do ticker de 1 min após a metade do TTL). O LiveKit renova o token da sessão conectada sozinho (refresh a cada 5 min pela sinalização); nosso token só serve para `connect` novo. Cliente nunca reconecta o Room ao receber `media` novo.
- O tipo vive em `media`: `media.Grant{URL, Token string; ExpiresAt time.Time}`, devolvido por `*media.Issuer`. A interface fica no consumidor (`realtime`): `MediaIssuer{ Issue(identity, name, room string, now time.Time) (media.Grant, error) }`; nil desliga mídia.
- Testes: decodificar e validar header/HMAC/JSON exato/`exp-nbf`. Integração pulável com `VB_OFFICE32_LIVEKIT_TEST_URL`: `GET {url}/rtc/validate?access_token=…` → 200; segredo errado/expirado/sem roomJoin → 401. CI: job com `docker run -d --network host livekit/livekit-server:v1.13 --dev` + espera + `go test -run LiveKit ./internal/media`.

### Room/protocolo
- Join: `welcome` → `media` → `nearby` (sempre, mesmo vazio) → broadcast `joined`.
- Tick: `state` → `nearby` dos alterados. `tick()` não retorna cedo se `len(d.Nearby) > 0`.
- Renovação: ticker de 1 min no `select` do `Room.Run` (canal nil sem mídia); reemite para membros com `renewAt` vencido; testado com relógio falso (`testing/synctest`).
- `media`: `{url, token, expiresAt}` com `expiresAt` em unix **ms**. `nearby`: `{ids}` ordenado, sem o próprio.
- Space calcula proximidade sempre; Room só envia com mídia configurada.
- Nunca logar token.

### Config
- `VB_OFFICE32_LIVEKIT_URL`, `_API_KEY` (não é segredo: vai no `iss`), `_API_SECRET` (segredo). Todas ou nenhuma; erro cita a env faltante; nunca ecoa valor.
- URL `wss://`, ou `ws://` só localhost/127.0.0.1; sem path/query/userinfo (reusar `validBaseURL`).
- Segredo < 32 chars → só Warn (o `secret` do dev precisa passar).

### Dev
- `make livekit`: `docker run --rm --name vb-office-32-livekit --network host livekit/livekit-server:v1.13 --dev` (Linux). Documentar alternativa portável (`-p 7880 -p 7881 -p 7882/udp --bind 0.0.0.0 --node-ip …`).
- `dev-oidc` inclui `livekit` só se `VB_OFFICE32_LIVEKIT_URL` for `ws://localhost[:porta]` ou `ws://127.0.0.1[:porta]`.
- `.env.example`: bloco LiveKit dev (`ws://localhost:7880`, `devkey`, `secret`).
- Browser conecta direto em `ws://localhost:7880` (sem proxy no Vite).

### Docs
- `docs/livekit.md` genérico (rede: UDP mux 7882, TCP 7881, TURN/TLS opcional, IP público estável, rede host, por que não atrás de LB comum, sinalização via proxy TLS, renovação de token, custo, `livekit.yaml` mínimo). README e `docs/deploy.md` atualizados.
- `phase1-protocol.md`: mensagens `media`/`nearby`, ordem, regra de proximidade.
- Backlog: `RemoveParticipant` (Twirp, stdlib) no leave com carência ~30 s — revogação real de quem perde o WS (LiveKit renova token indefinidamente); permissões de trilha do publicador (`setTrackSubscriptionPermissions`) como enforcement barato (fase 5); CSP `connect-src` com URL do LiveKit; métricas Prometheus em fase posterior.

## 3b — decisões (cliente)

- SDK via `await import('livekit-client')` só ao receber `media` (chunk separado).
- `new Room({ adaptiveStream: true, dynacast: true, webAudioMix: true, publishDefaults: { simulcast: true, videoSimulcastLayers: [VideoPresets.h90], dtx: true, red: true }, videoCaptureDefaults: { resolution: VideoPresets.h180.resolution } })`; `room.connect(url, token, { autoSubscribe: false })`.
  - Implementado com captura `h360` e `videoEncoding: VideoPresets.h180.encoding`: o SDK (2.23) só gera simulcast com lado maior ≥ 480 px, então captura 180p publicava uma camada só. Resultado: camadas 160×90 (90 kbit/s) e 640×360 limitada a 160 kbit/s; tiles de 160×90 puxam a de 90p e o dynacast pausa a de cima.
- Reconciliação de assinaturas por snapshot (`remoteParticipants` × `trackPublications`) em: `nearby`, `TrackPublished`, `ParticipantConnected`, `Connected`/`Reconnected`. `setSubscribed(bool)`.
- **Vídeo assinado só dos K=8 mais próximos**; áudio sem limite. Função pura.
- Volume: `RemoteParticipant.setVolume` (aplica mesmo antes de publicar); curva 1,0 em d ≤ 1, linear até 0,2 em d = 4, **0,2 na faixa de histerese** até sair.
- Áudio: `attach()` em container oculto no `TrackSubscribed`, `detach().remove()` no `TrackUnsubscribed`. Autoplay: `room.canPlaybackAudio` + `AudioPlaybackStatusChanged` → botão "Ativar áudio" chamando `room.startAudio()` no clique.
- Mic ligado ao entrar (pede permissão), estado no HUD, mute lembrado em localStorage (try/catch). Câmera off por padrão; `setCameraEnabled(false)` **muta** (câmera para, sem egress) — aceito no lugar de despublicar.
- Erros de dispositivo via `MediaDeviceFailure.getFailure`.
- Fala: `IsSpeakingChanged`/`ActiveSpeakersChanged`, mostrado só para `nearby` e si mesmo (primeiro corte se apertar).
- Reconexão: WS caiu → mantém Room até novo `nearby`; `replaced`/`expired` → `room.disconnect()`; Room caiu com motivo ≠ `CLIENT_INITIATED`/`DUPLICATE_IDENTITY`/`PARTICIPANT_REMOVED` → reconectar com backoff usando último token se `expiresAt > agora+30s`, senão aguardar próximo `media`. `DUPLICATE_IDENTITY` não reconecta.
- Testes vitest só de lógica pura (`volumeAt`, `subscriptionChanges`, top-K, parse de `media`/`nearby`, `MediaClient` com adaptador de Room falso). WebRTC real em checklist manual (Chrome `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream`).
