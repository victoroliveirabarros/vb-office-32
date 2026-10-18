# Backlog

## Fase 2

- Rate limit de mensagens por sessão (`move`/`ping`), fechando com 1008 ao exceder.
- Limite de conexões simultâneas (global e por IP).
- Limite de `Space.last` (última posição por identidade): hoje cresce sem limite durante a vida do processo; definir TTL ou tamanho máximo com expulsão.
- `VB_OFFICE32_ALLOWED_ORIGINS`: default vazio (só mesma origem). Hoje `env()` trata vazio como ausente e o default `localhost:5173,127.0.0.1:5173` vale em produção. Origens do Vite passam a ser definidas pelo `make web-dev`/`make run`.
- `.env.example` versionado com todas as `VB_OFFICE32_*` (valores de dev, segredos vazios); `.env` no `.gitignore`; `Makefile` carrega `.env` se existir.
- Novas envs: `VB_OFFICE32_PUBLIC_URL`, `VB_OFFICE32_GOOGLE_CLIENT_ID`, `VB_OFFICE32_GOOGLE_CLIENT_SECRET` (segredo), `VB_OFFICE32_ALLOWED_DOMAINS`, `VB_OFFICE32_SESSION_KEY` (segredo). Config falha no boot se SSO habilitado e faltar alguma; segredos nunca logados.

## Fase 3

- Envs LiveKit: `VB_OFFICE32_LIVEKIT_URL`, `VB_OFFICE32_LIVEKIT_API_KEY` (segredo), `VB_OFFICE32_LIVEKIT_API_SECRET` (segredo).
