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

## Revogação persistente de mídia (feito)

S5 em [`security-hardening.md`](security-hardening.md): webhook `participant_joined` remove na hora quem está ativo no LiveKit sem WS nem carência; `ListParticipants` a cada 1 min como rede de segurança; `media` reemitido quando uma remoção termina com a identidade de volta; o cliente reconecta na hora se a remoção chega menos de 10 s depois de um `media`. Junto: `form-action 'self'`, `media-src 'self'`, aviso quando `SESSION_KEY_PREVIOUS` = `SESSION_KEY`, log de remoção em Info só quando havia participante.

## Depois do hardening

- Revogação total de mídia: o LiveKit entrega um token novo de 10 min 1 ms após cada join, antes de qualquer webhook, então um cliente modificado reentra para sempre (cada tentativa dura ~40 ms com webhook e não completa a mídia, mas vê quem está na sala). Fechar exigiria trocar o API secret, rodar o LiveKit com TTL de refresh menor (não configurável no v1.13) ou uma lista de bloqueio no próprio LiveKit. `UpdateParticipant` antes do Remove não resolve (validado).
- Teste automatizado do webhook com participante ativo (precisa de cliente WebRTC; hoje validado à mão com Chrome headless).

## Fase 4a — chat no servidor (feito)

Escopo e decisões em [`phase4.md`](phase4.md) (refinamento 4a): pacote puro `internal/chat` (limpeza do texto, histórico de 100, ids), validação, limpeza e limite de chat (0,5/s, burst 5) na goroutine de leitura da sessão, roteamento no Room (`room_chat.go`), `maxMessageSize` 8 KiB, `nearby` enviado também sem mídia, `chatHistory` sempre no join. Contrato em `phase1-protocol.md` (seção Chat). `loadbot -chat`.

## Depois da fase 4a (4c)

- DM por clique no avatar; desambiguação de nomes repetidos na lista de presentes.
- Bucket de `everyone` por Room: hoje só há limite por conexão, então muitos remetentes juntos podem encher o buffer de envio (64) de um cliente lento e derrubá-lo por `slow consumer`.
- TTL do histórico (hoje fica até o restart) e bucket de chat por identidade (hoje é por conexão; reconectar zera).
- Alias opaco no lugar de `oidc:<sub>` nos ids que vão para os clientes.

## Descartado

- Limite de conexões por IP. Atrás de proxy/load balancer o servidor só vê o IP do proxy; o IP real chega por `X-Forwarded-For`, que o cliente consegue forjar a menos que a cadeia de proxies confiáveis seja configurada. Um limite assim seria contornável ou bloquearia todos atrás do mesmo proxy. O limite global (`VB_OFFICE32_MAX_SESSIONS`), o rate limit por conexão e a autenticação cobrem o risco.
