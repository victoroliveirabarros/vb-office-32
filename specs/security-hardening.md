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

- `Content-Security-Policy`: `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' <LIVEKIT ws(s) origin> <LIVEKIT http(s) origin>; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self' <OIDC issuer origin>; frame-ancestors 'none'`. Ajustar ao que o app realmente precisa (Phaser usa canvas/WebGL, blobs; o build do Vite não pode depender de inline). Se `index.html` tiver `<style>` inline, mover para arquivo CSS importado pelo bundle (preferível a `'unsafe-inline'`). Verificar no browser real que nada quebra (Phaser, LiveKit, login).
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

## Fora

- Revogação server-side de sessão HTTP (estado no servidor) — continua no backlog.
- Credenciais em texto puro no repositório de infra da empresa (ação do time de infra).

## Critérios de aceite

- Cliente que perde o WS é removido do LiveKit ~30 s depois (validado contra LiveKit real); reconexão dentro da carência não remove.
- Headers presentes; app (login, mapa, mídia) funciona no browser com CSP ativa, sem violações no console.
- Rotação de chave sem logout.
- `go vet`, `go test -race`, staticcheck, govulncheck, `npm test`, `npm run build` verdes.
