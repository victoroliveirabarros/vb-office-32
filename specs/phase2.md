# Fase 2 — Login OIDC, hardening e prontidão para deploy

Base: fase 1 concluída (`phase1-*.md`), `backlog.md`. Mesmos padrões: Go idiomático, comentários mínimos, stdlib primeiro, TS sem `any`.

## Contexto

- Repositório público open source. **Nada específico da empresa entra aqui** (hostnames internos, account IDs, nomes de cluster, chart interno). Isso vive só no fork da empresa.
- Fork da empresa: EKS, Helm chart compartilhado, Istio (TLS termina no gateway, NLB TCP na frente), External Secrets (env via `envFrom`), Karpenter com nós spot arm64, builds multi-arch amd64+arm64. A aplicação precisa ser compatível com isso sem conhecê-lo.

## Complexidade

Score 14 (complexo): 6+ arquivos, deps novas (`golang.org/x/oauth2`, `github.com/coreos/go-oidc/v3`), integração externa nova (OIDC), regras de segurança, risco alto (auth).

## User story

Como colega de time, entro no escritório com minha conta Google Workspace da empresa; quem não é do domínio não entra.

## Escopo

### A. Autenticação OIDC (genérica, Google como padrão)

- `VB_OFFICE32_AUTH=oidc|guest`. **Default `oidc`** (seguro por padrão). `guest` só para dev/testes; ao subir com guest, logar Warn.
- Config OIDC (boot falha se `AUTH=oidc` e faltar algo; segredos nunca logados):
  - `VB_OFFICE32_PUBLIC_URL` — ex. `https://office.exemplo.com`; deriva redirect `/auth/callback` e flag `Secure` do cookie (https).
  - `VB_OFFICE32_OIDC_ISSUER` — default `https://accounts.google.com`. Genérico para permitir outro provedor (ex. Cognito) só por config.
  - `VB_OFFICE32_OIDC_CLIENT_ID`, `VB_OFFICE32_OIDC_CLIENT_SECRET` (segredo).
  - `VB_OFFICE32_ALLOWED_DOMAINS` — lista por vírgula, obrigatória.
  - `VB_OFFICE32_SESSION_KEY` (segredo) — base64, ≥ 32 bytes decodificados.
- Fluxo:
  - `GET /auth/login` → gera `state`, `nonce`, PKCE verifier; guarda em cookie curto (10 min) assinado, `HttpOnly`, `SameSite=Lax`; redireciona ao provedor (scopes `openid email profile`; para Google, `hd` como dica quando houver 1 domínio).
  - `GET /auth/callback` → valida `state`, troca code com PKCE, verifica ID token (go-oidc: assinatura, `aud`, `iss`, `exp`, `nonce`). Autorização: `email_verified == true` **e** domínio do email ∈ ALLOWED_DOMAINS; se a claim `hd` existir, também deve ∈ ALLOWED_DOMAINS. Falha → 403 com página simples, sem detalhes internos.
  - Sucesso → cookie de sessão `vb_office32_session`: payload `{sub, name, email, exp}` com HMAC-SHA256 (stdlib), `HttpOnly`, `SameSite=Lax`, `Secure` conforme PUBLIC_URL, `Path=/`, validade 12 h. Comparação em tempo constante.
  - `POST /auth/logout` → apaga cookie, 204.
  - `GET /api/session` → 200 `{id, name, auth}` ou 401 `{auth}` (frontend decide tela).
- Identidade OIDC: `ID = "oidc:" + sub`; `Name` = claim `name` (fallback parte local do email), trim, cortado em 32 runes. Nomes com acento são válidos (renderização é canvas/`textContent`).
- WebSocket: em modo OIDC autentica pelo cookie no upgrade (sem cookie válido → 401 antes do upgrade); `name` da query ignorado. Origin check permanece (proteção CSWSH).
- Interface `Authenticator` continua no consumidor; `auth.Guest` e `auth.OIDC` implementam. Handlers HTTP de login/callback/logout no pacote `auth` ou `httpapi` — escolher o que mantiver `auth` coeso e testável.
- Testes: provedor OIDC falso com `httptest` (discovery + JWKS + token endpoint, chave RSA gerada no teste). Casos: sucesso, state inválido, nonce inválido, `aud` errado, email não verificado, domínio fora, `hd` fora, cookie adulterado, cookie expirado, WS sem cookie → 401.

### B. Frontend

- Boot chama `/api/session`:
  - 200 → entra direto com o nome da sessão.
  - 401 `auth=oidc` → tela "Entrar com Google" (link `/auth/login`).
  - 401 `auth=guest` → formulário de nome atual.
- Botão "Sair" (POST `/auth/logout` → volta à tela de login).
- WS em modo OIDC sem `?name`.
- Close 4001 continua com aviso "sessão aberta em outra aba".

### C. Hardening (do backlog)

- Rate limit por sessão: token bucket (20 msg/s, burst 40). Excedeu → close 1008 `"rate limit"`, log Warn.
- Limite global de sessões: `VB_OFFICE32_MAX_SESSIONS` (default 200). Excedeu → 503 antes do upgrade.
- `Space.last`: TTL 24 h ou cap 1000 com expulsão do mais antigo — escolher o mais simples e testável.

### D. Config e dev

- `VB_OFFICE32_ALLOWED_ORIGINS`: default vazio (só mesma origem). Distinguir "não definida" de "vazia" não é necessário: default passa a ser vazio.
- `.env.example` versionado com todas as `VB_OFFICE32_*` (dev: `AUTH=guest`, origens do Vite; segredos vazios). `.env` no `.gitignore`. `Makefile` carrega `.env` se existir (`-include .env` + `export`).
- README: tabela de envs atualizada (obrigatória/default/segredo).

### E. Prontidão para deploy (genérico)

- Dockerfile multi-arch eficiente: estágios node e Go com `--platform=$BUILDPLATFORM`, Go cross-compila com `GOOS=$TARGETOS GOARCH=$TARGETARCH`. `docker buildx build --platform linux/amd64,linux/arm64` deve funcionar.
- `GET /readyz` separado de `/healthz`: readiness vira 503 ao receber SIGTERM, antes de fechar sessões.
- Shutdown: SIGTERM → readyz 503 → fecha sessões com 1001 `"server restarting"` → encerra dentro de 10 s. Cliente reconecta com backoff (já existe; validar que 1001 não é tratado como 4001).
- `docs/deploy.md` genérico: porta única 8080 (`http`), probes, envs, 1 réplica com estratégia `Recreate` (estado em memória), WS atrás de proxy (timeouts ociosos > 20 s de ping), `terminationGracePeriodSeconds` ≥ 15, recomendação de anotação para não ser interrompido por autoscaler de nós (ex. Karpenter `karpenter.sh/do-not-disrupt`), TLS terminado no proxy com `PUBLIC_URL` https. Sem nomes da empresa.

## Fora

- Postgres, LiveKit, chat, zonas, métricas Prometheus (registrar métricas no backlog da fase 3).
- Arquivos do fork da empresa (values do chart, workflow de deploy, ExternalSecret, DNS).

## Critérios de aceite

- Given `AUTH=oidc` sem `CLIENT_ID`, When sobe, Then falha com erro claro citando a env.
- Given usuário do domínio permitido, When completa login, Then cookie de sessão setado e `/api/session` 200 com nome.
- Given email de outro domínio ou não verificado, Then 403 e nenhum cookie de sessão.
- Given cookie adulterado/expirado, Then `/api/session` 401 e WS 401 antes do upgrade.
- Given sessão válida, When abre WS sem `name`, Then `welcome` com `selfId="oidc:<sub>"`.
- Given > 40 mensagens instantâneas, Then close 1008 `"rate limit"`.
- Given SIGTERM, Then `/readyz` 503 imediatamente e clientes recebem 1001 e reconectam ao voltar.
- `docker buildx build --platform linux/amd64,linux/arm64 .` ok (se buildx disponível; senão documentar).
- `go vet`, `go test -race ./...`, `npm test`, `npm run build` verdes; loadbot (modo guest) sem regressão.

---

# Refinamento técnico (vence o texto acima em caso de conflito)

## Divisão

- **2a (baixo risco):** C, D, E (sem partes de OIDC). Implementar primeiro.
- **2b (segurança):** A, B + linhas de OIDC no README/deploy.md.

## Dependências (Go 1.27.2)

- `github.com/coreos/go-oidc/v3`, `golang.org/x/oauth2`, `github.com/go-jose/go-jose/v4`: sempre a última versão (`go get <mod>@latest`), sem fixação.
- `golang.org/x/time/rate` é permitido, mas o rate limit do WS continua no token bucket próprio (`internal/realtime/ratelimit.go`); não trocar.
- CI roda `govulncheck`.

## 2a — decisões

- Rate limit: `internal/realtime/ratelimit.go`, `tokenBucket{rate, burst, tokens, last}` + `allow(now) bool`, sem lock (só readLoop usa). 20/s, burst 40. Conta toda mensagem recebida (inclusive inválida), antes do decode. Close 1008 `"rate limit"`.
- Max sessions: semáforo `slots chan struct{}` no handler realtime; ordem: auth → slot não bloqueante (cheio → 503 `"server full"`) → Accept; libera após `room.leave`. Conta conexões, não identidades.
- `Space.last`: cap 1000 com expulsão do mais antigo (contador `order` monotônico; `world` não tem relógio). `Join` remove a entrada usada. Cap sobrescrevível em teste.
- Limite por IP: fora (IP real só via X-Forwarded-For, não confiável). Registrar motivo no backlog.
- Shutdown: `ready atomic.Bool`; SIGTERM → `ready=false` (`/readyz` e `/ws` → 503) → cancela hub (1001 `"server restarting"`, ≤ 5 s) → `srv.Shutdown` com deadline total 10 s. Listener fica aberto durante o drain. Unificar reason do 1001 em `"server restarting"`.
- `httpapi.NewHandler(Options{WS, Ready, MapsDir, WebDir, ...})`; `/readyz`; `/ws` envolto em `whenReady`. Mux inteiro com `http.NewCrossOriginProtection().Handler` (stdlib 1.25).
- `cmd/vb-office-32/config.go` separado de `main.go`. Erros citam a env, nunca o valor. `ALLOWED_ORIGINS` default vazio (coder/websocket compara Origin com Host; proxy do Vite preserva Host).
- `.dockerignore` inclui `.env`. Makefile `-include .env` + `export` (documentar: sem aspas/`$`).
- Dockerfile: `FROM --platform=$BUILDPLATFORM` nos estágios node e go, `ARG TARGETOS TARGETARCH`, cache mounts, `GOOS/GOARCH`.
- `realtime/handler.go`: erros de auth que não sejam `ErrInvalidName` respondem `http.StatusText(401)`, nunca `err.Error()`.
- Frontend 2a: `closeAction(code)` puro — 4001 → replaced; demais (1001, 1008, 1006) → reconnect.

## 2b — decisões de segurança

- **Subchaves via HKDF** (`crypto/hkdf`) de `SESSION_KEY` por propósito: `"vb-office-32 session v1"` e `"vb-office-32 oidc-flow v1"`. Cookie de um nunca vale pelo outro (teste).
- Formato do cookie: `base64url(json).base64url(hmac)`, payload com `v:1` e `exp` validado no servidor. Limite de tamanho no decode. `hmac.Equal`.
- Cookie de fluxo `vb_office32_oidc`: `{state, nonce, verifier, exp}`, `Path=/auth/`, `MaxAge=600`, apagado no callback (sucesso ou falha). `state`/`nonce` com `crypto/rand.Text()`, verifier com `oauth2.GenerateVerifier()`.
- **go-oidc não valida nonce, `email_verified` nem `hd`**: comparar nonce manualmente em tempo constante.
- Autorização (`authorize(claims, allowed, requireHD)` pura):
  - `email_verified` aceita bool ou `"true"` (tipo `flexBool`).
  - Domínio = após último `@`, minúsculas, ∈ ALLOWED_DOMAINS.
  - **Issuer `https://accounts.google.com` exige `hd` presente** e ∈ ALLOWED_DOMAINS (bloqueia conta Google pessoal criada com email corporativo). Outros issuers: só domínio do email.
- Respostas do callback: 400 para state/cookie de fluxo inválido ("sessão de login expirada, tente de novo"); 403 para não autorizado; página genérica para `?error=` do provedor. Nunca ecoar parâmetros do provedor. Sempre `303 → /` no sucesso; sem `next`.
- Sessão: payload `{v, sub, name, email, exp}`; **revalidar domínio em cada `Authenticate`** (remover domínio da config revoga). `Identity.Expires`; sessão WS fecha no `exp` com **4002 `"session expired"`**.
- `PUBLIC_URL` é a única fonte de scheme/host: ignorar `r.TLS` e `X-Forwarded-*`. Boot valida: `https`, ou `http` só com `localhost`/`127.0.0.1`; sem path (ou `/`), sem query.
- Discovery OIDC **lazy com retry** (mutex + cache, não `sync.Once`): evita CrashLoop se o sidecar Istio não estiver pronto. `/auth/login` → 503 enquanto falhar. Validação de config segue síncrona no boot.
- HTTP client de saída com timeout 10 s (via `oidc.ClientContext` / `oauth2.HTTPClient`).
- Nome do IdP: `strings.ToValidUTF8`, remove `unicode.IsControl` e `unicode.Cf` (bidi), trim, 32 runes; fallback parte local do email. Guest continua 24 ASCII.
- Headers: `Cache-Control: no-store` em `/auth/*` e `/api/session`; `Referrer-Policy: no-referrer` no callback. Logs só `oidc:<sub>` e motivo da negação; nunca code/token/email.
- Cookie de sessão com prefixo `__Host-` quando Secure.
- `/api/session`: guest → sempre 401 `{auth:"guest"}`; oidc → 200 `{id,name,auth:"oidc"}` ou 401 `{auth:"oidc"}`. Email não exposto.
- Botão com texto fixo "Entrar" (provedor genérico).
- Pacote: handlers Login/Callback/Logout em `internal/auth` (`oidc.go`, `signer.go`, `session.go`); `NewOIDC` não faz rede.
- Frontend 2b: `net/session.ts` (`parseSession` puro, `fetchSession`, `logout` com fetch injetável); `wsUrl(name?)`; status `'expired'`; `closeAction` 4002 → expired; **upgrade negado aparece como 1006 no browser**: `Connection` recebe `checkAuth()`; tentativa que fecha sem abrir chama `checkAuth`, se 401 emite `'expired'` e para backoff. Logout/expired → `location.assign('/')`. Vite proxy para `/auth` e `/api`. Em dev, `PUBLIC_URL=http://localhost:5173`.
- Testes: IdP falso em `internal/auth/fakeidp_test.go` (discovery, JWKS, token com checagem PKCE, ID token RS256 assinado à mão, `now` injetado). Casos: sucesso, state divergente, cookie de fluxo ausente/expirado, cookie de fluxo como sessão, nonce/aud/iss errados, token expirado, kid desconhecido, PKCE errado, email_verified false e "true", domínio fora, hd fora, hd ausente com Google (teste da regra pura), `?error=`, sessão adulterada/expirada, domínio removido após login, sanitização de nome, logout cross-site → 403.

## Atualizar contratos

- `phase1-protocol.md`: identidade `oidc:<sub>`, close 4002, 1008 `"rate limit"`, 503 antes do upgrade (cheio/drain), nome por modo.
- `backlog.md`: trocar `GOOGLE_*` por `OIDC_*`; adicionar `SESSION_KEY_PREVIOUS`, revogação no servidor, `prompt=select_account`, CSP/headers, logout RP-initiated, job buildx no CI, métricas Prometheus (fase 3).
