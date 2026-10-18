# Backlog

## Fase 2

- Rate limit de mensagens por sessão (`move`/`ping`), fechando com 1008 ao exceder.
- Limite de conexões simultâneas (global e por IP).
- Limite de `Space.last` (última posição por identidade): hoje cresce sem limite durante a vida do processo; definir TTL ou tamanho máximo com expulsão.
