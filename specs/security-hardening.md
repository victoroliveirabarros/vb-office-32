# Hardening de segurança (pós-fase 3)

Base: `backlog.md`, `phase2.md`, `phase3.md`, `docs/livekit.md`. Mesmos padrões: Go idiomático, stdlib, comentários mínimos, TS sem `any`. Nada específico da empresa.

## Complexidade

Score 11 (médio): integração nova com API admin do LiveKit, headers globais, rotação de chave.

## S1 — Revogar mídia de quem sai (`RemoveParticipant`)

Problema: o LiveKit renova o token da sessão conectada indefinidamente. Quem perde o WS (saiu, 4002 expirado, domínio removido, substituído por outro processo) continua na chamada se usar cliente modificado.

- Ao `handleLeave` de um membro com mídia: agendar remoção com carência de **30 s** (reconexão normal do WS cancela). Se a identidade voltar dentro da carência → cancela.
- Remoção: `POST {LIVEKIT_URL http(s)}/twirp/livekit.RoomService/RemoveParticipant`, JSON `{"room": "...", "identity": "..."}`, header `Authorization: Bearer <token admin>`, `Content-Type: application/json`. Token admin: mesmo signer HS256, grants `{"room": "<room>", "roomAdmin": true}`, TTL curto (1 min), sem `roomJoin`. Converter `ws://`→`http://`, `wss://`→`https://`.
- Resposta 404/`not_found` (participante já saiu) = sucesso. Erros de rede/5xx: log Warn sem token, sem retry infinito (1 retry com backoff curto basta).
- Execução fora do goroutine do Room (não bloquear tick): o Room decide e agenda; um executor com `http.Client` timeout 5 s faz a chamada. Timers cancelados no shutdown; no shutdown do servidor, **não** remover todos (deploy com `Recreate` reconecta todo mundo).
- Interface no consumidor (`realtime`), implementação em `internal/media`. Sem dependências novas.
- Expiração de sessão (4002) e substituição: na substituição (4001) a identidade continua presente → não remove. No 4002 → leave normal → carência → remove (cliente honesto já desconectou; cliente malicioso perde a mídia).
- Testes: carência cancelada por rejoin; remoção após carência; 404 tratado como sucesso; token admin com grants exatos; integração pulável contra LiveKit real (participante conectado via token nosso é removido — pode usar `ListParticipants` admin para verificar, ou conexão de teste).

## S2 — CSP e headers de segurança

Aplicar a todas as respostas HTML/estáticas (middleware em `httpapi`):

- `Content-Security-Policy` (depois do QA: `media-src 'self'` sem `blob:`, já que a mídia toca por `srcObject`; `form-action 'self'` sem o issuer, já que o login é link): `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' <LIVEKIT ws(s) origin> <LIVEKIT http(s) origin>; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self' <OIDC issuer origin>; frame-ancestors 'none'`. Ajustar ao que o app realmente precisa (Phaser usa canvas/WebGL, blobs; o build do Vite não pode depender de inline). Se `index.html` tiver `<style>` inline, mover para arquivo CSS importado pelo bundle (preferível a `'unsafe-inline'`). Verificar no browser real que nada quebra (Phaser, LiveKit, login).
- `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` (ou `strict-origin-when-cross-origin` se algo precisar), `Permissions-Policy: camera=(self), microphone=(self), geolocation=(), display-capture=()`, `Cross-Origin-Opener-Policy: same-origin`.
- `Strict-Transport-Security: max-age=31536000` **só** quando `PUBLIC_URL` é https.
- Páginas de erro do auth continuam com seus headers próprios.
- Testes de headers por rota; teste manual no browser (dev via Vite: o Vite não aplica nossos headers — documentar; validar com o build servido pelo Go).

## S3 — Rotação de `SESSION_KEY` sem derrubar sessões

- `VB_OFFICE32_SESSION_KEY_PREVIOUS` (opcional, segredo): sessões e cookies de fluxo assinados com a chave anterior continuam válidos para **leitura**; novos cookies sempre com a chave atual. Mesma validação de tamanho.
- Documentar procedimento: definir PREVIOUS = atual, gerar nova atual, deploy; após 12 h (TTL da sessão), remover PREVIOUS.
- Testes: cookie antigo aceito com PREVIOUS; recusado sem; novo cookie sempre com a atual.

## S4 — DNS rebinding no dev (M6)

- `web/vite.config.ts`: `server.allowedHosts` restrito a `localhost`/`127.0.0.1` (verificar se o Vite 8 aplica a checagem também ao upgrade WS do proxy; se não, documentar e mitigar).
- Validar: `Host: evil.com:5173` no `/ws` via Vite → rejeitado.
- Documentado (QA): o backend Go acessado direto (sem Vite) não checa `Host`; em modo guest (só dev) um rebinding abre `/ws` com `Host`/`Origin` batendo, sem ganho, já que guest aceita qualquer um; em OIDC não tem efeito (o cookie é do host real). HSTS só sai com `PUBLIC_URL` https, isto é, só em modo OIDC.

## S5 — Webhook e reconciliação da sala de mídia

Problema (lacuna do S1, I2 do QA): remover do LiveKit não revoga o token. O LiveKit manda um token novo (`refreshToken`, 10 min, mesmos grants) 1 ms depois de cada join, então um cliente modificado reentra indefinidamente encadeando tokens. E uma remoção em voo quando o jogador reconecta (I1) derrubava a mídia nova até o próximo `media` (~5 min).

Decisão:

- **Webhook** `POST /livekit/webhook` (só com mídia ligada): `participant_joined` de identidade que não é membro nem está em carência → `RemoveParticipant` na hora, emitida por nós ou não. Verificação stdlib em `internal/media` (`Client.ReadEvent`), conferida contra um webhook real do v1.13: `Content-Type: application/webhook+json`; `Authorization` = JWT cru (aceita também `Bearer `), HS256 com o API secret, `iss` = API key, `nbf`/`exp` (5 min) com 30 s de tolerância, `sha256` = base64 padrão do SHA-256 do corpo; corpo ≤ 1 MiB. Assinatura inválida/expirada → 401, resto inválido → 400; o token nunca vai para log nem erro. Sala desconhecida e outros eventos → 200 sem efeito. Configuração: `webhook.api_key` + `webhook.urls` no `livekit.yaml`; no dev, `make livekit` passa `LIVEKIT_CONFIG` apontando para `http://127.0.0.1:8080/livekit/webhook` (`LIVEKIT_WEBHOOK` sobrescreve).
- **Reconciliação** como rede de segurança: no check de mídia de 1 min, `ListParticipants` `{"room": "..."}` com o token admin do Remove. Uma lista em voo por vez (flag no Room, limpa quando o resultado volta, com ou sem erro); erro → Warn sem token, sem retry. Pega o que o webhook não pega: webhook perdido e cliente que só abre a sinalização sem conectar mídia (o LiveKit não emite `participant_joined` para ele; derruba sozinho após 60 s).
- Desenho: as chamadas HTTP rodam fora do goroutine do Room e o resultado volta por canal; o Room decide com o estado **do momento da resposta** (não membro e não em carência). Escolhido em vez de snapshot porque quem conecta durante a listagem não é removido por engano, e não há estado compartilhado.
- Remoções (carência, webhook, reconciliação) passam por um único caminho: decididas no Room (carência revalidada pelo `seq`), executadas fora dele. Ao terminar (sucesso ou erro, porque um timeout pode ter removido), o resultado volta ao Room; se a identidade estiver conectada, recebe `media` novo na hora. `Remove` passa a dizer se o participante existia: Info só quando removeu, 404/`not_found` em Debug.
- Cliente web: depois de `removed`, se o último `media` chegou há menos de 10 s (o servidor só remove quem está sem WS há ≥ 30 s ou nunca teve, portanto sem `media` recente), reconecta com ele; cobre o `media` que chega antes do aviso de remoção do LiveKit. Senão continua esperando o próximo `media`.
- `UpdateParticipant` zerando permissões antes do Remove: **não adotado**. Validado contra LiveKit real que o `refreshToken` sai 1 ms após o join, antes do participante ficar ativo e antes de qualquer webhook; zerar depois não recupera o token já entregue.
- Limite aceito: o cliente modificado consegue reentrar para sempre, mas cada tentativa dura ~40 ms com webhook (até ~1 min sem ele) e não chega a completar a conexão de mídia; ele vê a lista de quem está na sala no join. Revogação total só trocando o API secret.
- Interface `realtime.Media` ganha `Participants`; `Remove` retorna `(bool, error)`; `realtime.EventReader` para o webhook. Sem dependências novas.
- Testes: reconciliação remove intruso e desconhecido, não remove membro nem quem está na carência; uma lista por vez (e nova depois de erro); decisão com os membros atuais; Remove lento (2 s) × rejoin reenvia `media`; webhook remove só quem está ativo sem sessão, ignora outros eventos/salas, 401/400 sem remoção; verificação do webhook (webhook real capturado do v1.13, segredo/chave errados, `alg` none, corpo adulterado, expirado, ainda não válido, Content-Type, tamanho); formato e token do `ListParticipants`; rota montada só com mídia e sem bloqueio de CrossOriginProtection; cliente reconecta após remoção com `media` recente; integração pulável contra LiveKit real da reconciliação. O caminho do webhook com participante ativo foi validado à mão com Chrome headless (precisa de WebRTC completo).

## Fora

- Revogação server-side de sessão HTTP (estado no servidor) — continua no backlog.
- Credenciais em texto puro no repositório de infra da empresa (ação do time de infra).

## Critérios de aceite

- Cliente que perde o WS é removido do LiveKit ~30 s depois (validado contra LiveKit real); reconexão dentro da carência não remove.
- Participante ativo no LiveKit sem WS (ou desconhecido) é removido em ≤ ~1 s via webhook, a cada reentrada; só sinalização ou webhook perdido, em até ~1 min.
- Headers presentes; app (login, mapa, mídia) funciona no browser com CSP ativa, sem violações no console.
- Rotação de chave sem logout.
- `go vet`, `go test -race`, staticcheck, govulncheck, `npm test`, `npm run build` verdes.
