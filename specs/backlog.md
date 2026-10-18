# Backlog

## Fase 2b — login OIDC

Escopo e decisões em [`phase2.md`](phase2.md) (seções A e B e "2b — decisões de segurança").

- Novas envs: `VB_OFFICE32_AUTH` (`oidc|guest`, default `oidc`), `VB_OFFICE32_PUBLIC_URL`, `VB_OFFICE32_OIDC_ISSUER`, `VB_OFFICE32_OIDC_CLIENT_ID`, `VB_OFFICE32_OIDC_CLIENT_SECRET` (segredo), `VB_OFFICE32_ALLOWED_DOMAINS`, `VB_OFFICE32_SESSION_KEY` (segredo). Config falha no boot se `AUTH=oidc` e faltar alguma; segredos nunca logados. Entram em `config.go`, `.env.example`, README e `docs/deploy.md`.
- Contrato: identidade `oidc:<sub>`, close 4002 `"session expired"`, nome por modo.

## Depois da fase 2

- `VB_OFFICE32_SESSION_KEY_PREVIOUS`: aceitar a chave anterior na validação para rotacionar sem derrubar sessões.
- Revogação de sessão no servidor (hoje o cookie vale até expirar, salvo domínio removido da config).
- `prompt=select_account` no login, para trocar de conta Google sem sair do provedor.
- CSP e demais headers de segurança nas páginas.
- Logout RP-initiated (`end_session_endpoint`) quando o provedor suportar.
- Job no CI com `docker buildx build --platform linux/amd64,linux/arm64`.

## Fase 3

- Envs LiveKit: `VB_OFFICE32_LIVEKIT_URL`, `VB_OFFICE32_LIVEKIT_API_KEY` (segredo), `VB_OFFICE32_LIVEKIT_API_SECRET` (segredo).
- Métricas Prometheus (sessões ativas, recusas por `server full`, closes por motivo, duração do tick, latência de ack).

## Descartado

- Limite de conexões por IP. Atrás de proxy/load balancer o servidor só vê o IP do proxy; o IP real chega por `X-Forwarded-For`, que o cliente consegue forjar a menos que a cadeia de proxies confiáveis seja configurada. Um limite assim seria contornável ou bloquearia todos atrás do mesmo proxy. O limite global (`VB_OFFICE32_MAX_SESSIONS`), o rate limit por conexão e a autenticação cobrem o risco.
