# Backlog

## Fase 2b — login OIDC (feito)

Escopo e decisões em [`phase2.md`](phase2.md) (seções A e B e "2b — decisões de segurança"). Envs `VB_OFFICE32_AUTH`, `VB_OFFICE32_PUBLIC_URL`, `VB_OFFICE32_OIDC_ISSUER`, `VB_OFFICE32_OIDC_CLIENT_ID`, `VB_OFFICE32_OIDC_CLIENT_SECRET`, `VB_OFFICE32_ALLOWED_DOMAINS`, `VB_OFFICE32_SESSION_KEY` documentadas no README e em `docs/deploy.md`; contrato (`oidc:<sub>`, 4002, nome por modo) em `phase1-protocol.md`.

## Depois da fase 2

- `VB_OFFICE32_SESSION_KEY_PREVIOUS`: aceitar a chave anterior na validação para rotacionar sem derrubar sessões.
- Revogação de sessão no servidor (hoje o cookie vale até expirar, salvo domínio removido da config).
- `prompt=select_account` no login, para trocar de conta Google sem sair do provedor.
- CSP e demais headers de segurança nas páginas.
- Logout RP-initiated (`end_session_endpoint`) quando o provedor suportar.
- Job no CI com `docker buildx build --platform linux/amd64,linux/arm64`.
- `client_secret_post` para provedores que não aceitem `client_secret_basic` (hoje fixo em Basic).
- M6 — DNS rebinding no proxy WS do Vite em dev: requisição com `Host`/`Origin` = `evil.com:5173` recebe 101 no `/ws` (o proxy preserva o Host e o check de Origin compara Origin com Host). Em `AUTH=oidc` o upgrade dá 401; em `guest` qualquer um já entra. Só dev; corrigir com `server.allowedHosts` no Vite ou checagem de Host no proxy.

## Fase 3a — servidor de mídia (feito)

Escopo e decisões em [`phase3.md`](phase3.md). Envs `VB_OFFICE32_LIVEKIT_URL`, `VB_OFFICE32_LIVEKIT_API_KEY` (não é segredo: vai no `iss`), `VB_OFFICE32_LIVEKIT_API_SECRET` (segredo) no README e em `docs/livekit.md`; mensagens `media`/`nearby` e regra de proximidade em `phase1-protocol.md`.

## Depois da fase 3a

- `RemoveParticipant` (Twirp, stdlib) no leave, com carência de ~30 s para reconexão: revogação real de quem perde o WS, já que o LiveKit renova o token da sessão conectada indefinidamente.
- Permissões de trilha do publicador (`setTrackSubscriptionPermissions`) como enforcement barato de quem assina quem (fase 5, junto com zonas).
- CSP `connect-src` incluindo a URL do LiveKit (junto com os demais headers de segurança).
- Métricas Prometheus em fase posterior (sessões ativas, recusas por `server full`, closes por motivo, duração do tick, latência de ack, logins negados por motivo, mídia emitida).

## Descartado

- Limite de conexões por IP. Atrás de proxy/load balancer o servidor só vê o IP do proxy; o IP real chega por `X-Forwarded-For`, que o cliente consegue forjar a menos que a cadeia de proxies confiáveis seja configurada. Um limite assim seria contornável ou bloquearia todos atrás do mesmo proxy. O limite global (`VB_OFFICE32_MAX_SESSIONS`), o rate limit por conexão e a autenticação cobrem o risco.
