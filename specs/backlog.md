# Backlog

## Fase 2b — login OIDC (feito)

Escopo e decisões em [`phase2.md`](phase2.md) (seções A e B e "2b — decisões de segurança"). Envs `VB_OFFICE32_AUTH`, `VB_OFFICE32_PUBLIC_URL`, `VB_OFFICE32_OIDC_ISSUER`, `VB_OFFICE32_OIDC_CLIENT_ID`, `VB_OFFICE32_OIDC_CLIENT_SECRET`, `VB_OFFICE32_ALLOWED_DOMAINS`, `VB_OFFICE32_SESSION_KEY` documentadas no README e em `docs/deploy.md`; contrato (`oidc:<sub>`, 4002, nome por modo) em `phase1-protocol.md`.

## Depois da fase 2

- Revogação de sessão no servidor (hoje o cookie vale até expirar, salvo domínio removido da config).
- `prompt=select_account` no login, para trocar de conta Google sem sair do provedor.
- Logout RP-initiated (`end_session_endpoint`) quando o provedor suportar.
- Job no CI com `docker buildx build --platform linux/amd64,linux/arm64`.
- `client_secret_post` para provedores que não aceitem `client_secret_basic` (hoje fixo em Basic).

## Fase 3a — servidor de mídia (feito)

Escopo e decisões em [`phase3.md`](phase3.md). Envs `VB_OFFICE32_LIVEKIT_URL`, `VB_OFFICE32_LIVEKIT_API_KEY` (não é segredo: vai no `iss`), `VB_OFFICE32_LIVEKIT_API_SECRET` (segredo) no README e em `docs/livekit.md`; mensagens `media`/`nearby` e regra de proximidade em `phase1-protocol.md`.

## Fase 3b — cliente de mídia (feito)

`web/src/media` (lógica pura + `MediaClient`, SDK só em `livekit.ts`, carregado sob demanda) e `web/src/ui/media.ts`. Desvio do refinamento: captura da câmera em 360p (não 180p), porque o SDK só faz simulcast com lado maior ≥ 480 px; camadas 90p (a que os tiles puxam) e topo limitado ao bitrate de 180p.

## Depois da fase 3a

- Permissões de trilha do publicador (`setTrackSubscriptionPermissions`) como enforcement barato de quem assina quem (fase 5, junto com zonas).
- Métricas Prometheus em fase posterior (sessões ativas, recusas por `server full`, closes por motivo, duração do tick, latência de ack, logins negados por motivo, mídia emitida).

## Hardening de segurança (feito)

Escopo em [`security-hardening.md`](security-hardening.md): `RemoveParticipant` 30 s após o WS fechar (carência cancelada por reconexão; nada removido no shutdown), CSP e headers em todas as respostas (HSTS só com `PUBLIC_URL` https; `<style>` do `index.html` movido para `web/src/style.css`), `VB_OFFICE32_SESSION_KEY_PREVIOUS` e checagem de `Host` no upgrade `/ws` do Vite (M6; `allowedHosts` sozinho não cobre o proxy WS no Vite 8). Desvio: o cliente passou a esperar o próximo `media` depois de `removed` (antes parava de vez), senão quem ficasse mais de 30 s sem WS perderia a mídia até recarregar a página.

## Depois do hardening

- Revogação de mídia persistente: removido, um cliente modificado entra de novo no LiveKit com o último token que tem (o nosso, até 10 min, ou o renovado pelo próprio LiveKit) e volta a ser renovado indefinidamente. Fechar com reconciliação periódica (`ListParticipants` no check de mídia de 1 min, removendo identidades fora de `members` e fora da carência).
- Corrida pequena: a remoção já em voo quando a identidade reconecta derruba a mídia recém-reconectada; o cliente honesto volta no próximo `media` (até ~5 min).

## Descartado

- Limite de conexões por IP. Atrás de proxy/load balancer o servidor só vê o IP do proxy; o IP real chega por `X-Forwarded-For`, que o cliente consegue forjar a menos que a cadeia de proxies confiáveis seja configurada. Um limite assim seria contornável ou bloquearia todos atrás do mesmo proxy. O limite global (`VB_OFFICE32_MAX_SESSIONS`), o rate limit por conexão e a autenticação cobrem o risco.
