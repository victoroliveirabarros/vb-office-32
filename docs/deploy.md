# Deploying vb-office-32

The server is a single static binary that serves the frontend, the maps and
the WebSocket on one port. All game state lives in memory, which shapes most
of the choices below.

## Image

```sh
docker build -t vb-office-32 .

# multi-arch; needs a builder with the docker-container driver
# (docker buildx create --use) or the containerd image store
docker buildx build --platform linux/amd64,linux/arm64 -t <registry>/vb-office-32:<tag> --push .
```

The build stages run on the builder's platform and Go cross-compiles, so
arm64 images build without emulation. The runtime image is distroless,
runs as non-root and listens on 8080.

## Configuration

Everything is set through `VB_OFFICE32_*` environment variables; see the
table in the [README](../README.md#configuration). In production:

- Leave `VB_OFFICE32_ALLOWED_ORIGINS` empty unless the page is served from a
  different host than `/ws`. The WebSocket origin check compares `Origin`
  with `Host`, so the proxy must forward the original `Host`.
- Size `VB_OFFICE32_MAX_SESSIONS` for the expected team plus a margin for
  several tabs per person; extra connections get HTTP 503.
- Invalid values make the process exit at boot with an error naming the
  variable, never its value.
- Keep `VB_OFFICE32_AUTH` at its default, `oidc`. Guest mode lets anyone in
  under any name.

## Login (OIDC)

Any OpenID Connect provider with discovery works; Google is the default
issuer.

1. Create an OAuth client of type "web application" at the provider, with
   the redirect URI `<PUBLIC_URL>/auth/callback`, for example
   `https://office.example.com/auth/callback`. The client authenticates with
   HTTP Basic (`client_secret_basic`).
2. Set the variables:

   | Variable | Example | Secret |
   |---|---|---|
   | `VB_OFFICE32_PUBLIC_URL` | `https://office.example.com` | no |
   | `VB_OFFICE32_OIDC_ISSUER` | `https://accounts.google.com` (default) | no |
   | `VB_OFFICE32_OIDC_CLIENT_ID` | from the provider | no |
   | `VB_OFFICE32_OIDC_CLIENT_SECRET` | from the provider | yes |
   | `VB_OFFICE32_ALLOWED_DOMAINS` | `example.com` | no |
   | `VB_OFFICE32_SESSION_KEY` | `openssl rand -base64 32` | yes |

   Deliver the two secrets from a secret store (a Kubernetes `Secret`
   mounted with `envFrom`, for instance), never in the image or in plain
   manifests.
3. Check the boot log: missing or invalid variables stop the process with
   the variable's name.

Notes:

- `VB_OFFICE32_PUBLIC_URL` is the only source of the scheme and host. The
  server ignores `X-Forwarded-Proto`/`X-Forwarded-Host` and the TLS state of
  its own connection, so a proxy that terminates TLS needs no extra headers.
  With `https` the session and login-flow cookies get the `__Host-` prefix
  and `Secure`.
- The provider is contacted on the first login, not at boot, and discovery
  is retried until it succeeds, so a sidecar or egress path that becomes
  ready after the container does not crash it. While the provider is
  unreachable `/auth/login` answers 503, and so do logins that arrive while
  the first discovery is still running. Outbound requests time out after
  10 s.
- `cmd/devidp` is a development provider that signs in anyone; the image
  builds only `./cmd/vb-office-32`, so never deploy or expose it.
- The pod needs egress to the issuer (for Google, `accounts.google.com`,
  `oauth2.googleapis.com` and `www.googleapis.com`).
- With the Google issuer the ID token must carry `hd` (Workspace accounts
  only) and it must be in `VB_OFFICE32_ALLOWED_DOMAINS`. Other issuers are
  checked by the email domain alone; make sure the provider only issues
  verified emails for domains it controls.
- Sessions last 12 hours. Removing a domain from the list revokes its
  sessions on their next request; replacing `VB_OFFICE32_SESSION_KEY`
  without the rotation below logs everyone out.

### Rotating the session key

`VB_OFFICE32_SESSION_KEY_PREVIOUS` (optional, secret, same format as the
key) keeps cookies signed with the old key valid for reading, while every
new cookie is signed with the current key.

1. Set `VB_OFFICE32_SESSION_KEY_PREVIOUS` to the current key.
2. Set `VB_OFFICE32_SESSION_KEY` to a new one (`openssl rand -base64 32`)
   and deploy. Nobody is logged out, and logins in progress finish.
3. After 12 hours (the session lifetime) every cookie signed with the old
   key has expired: remove `VB_OFFICE32_SESSION_KEY_PREVIOUS` and deploy.

To log everyone out instead (a leaked key), replace the key without setting
the previous one.

## Audio and video (optional)

Proximity audio and video need a LiveKit server next to this one; see
[`livekit.md`](livekit.md) for its network, configuration and cost. Point
vb-office-32 at it with:

| Variable | Example | Secret |
|---|---|---|
| `VB_OFFICE32_LIVEKIT_URL` | `wss://media.example.com` | no |
| `VB_OFFICE32_LIVEKIT_API_KEY` | the key configured in LiveKit | no |
| `VB_OFFICE32_LIVEKIT_API_SECRET` | the matching secret | yes |

Set all three or none. Besides signing tokens, vb-office-32 calls the
LiveKit room service at the same host over `http(s)`: `RemoveParticipant`
30 seconds after a player's WebSocket closes for good or as soon as someone
without a WebSocket joins, and `ListParticipants` once a minute as a safety
net. The pod needs egress to that URL as well as the browser. A failed
removal is logged as a warning and retried once; a failed list is logged and
tried again a minute later. Deliver the secret like the other secrets above.

LiveKit must also post its webhooks to `POST <server>/livekit/webhook`
(`webhook.urls` and `webhook.api_key` in `livekit.yaml`, see
[`livekit.md`](livekit.md#removal)). The route checks LiveKit's signature
(HS256 with the API secret, SHA-256 of the body) and answers 401 otherwise,
so it may go through the public ingress; an internal URL works as well when
LiveKit runs in the same network. Without webhooks the periodic list still
removes intruders, only up to a minute later.

## Security headers

All responses carry CSP, `X-Content-Type-Options`, `Referrer-Policy`,
`Permissions-Policy` and `Cross-Origin-Opener-Policy` (see the
[README](../README.md#security-headers)); the CSP already allows the LiveKit
URL from the configuration. HSTS (`max-age=31536000`) is sent only when
`VB_OFFICE32_PUBLIC_URL` is https, that is in oidc mode; serve production in
oidc mode behind https.
Proxies in front must not strip or replace these headers, and a page served
from another host needs that host in the CSP, which is not configurable.

## Port and probes

| Port | Name   | Protocol |
|------|--------|----------|
| 8080 | `http` | HTTP/1.1 and WebSocket on `/ws` |

- Liveness: `GET /healthz` (200 while the process runs).
- Readiness: `GET /readyz` (200 when serving, 503 as soon as shutdown starts).

## Replicas and rollout

Run exactly **one replica**. Positions and sessions are in memory; a second
replica would split the office in two. For the same reason use a `Recreate`
rollout instead of a rolling update: the old pod stops before the new one
starts, and clients reconnect to the new one by themselves.

Restarts forget last positions; players respawn at the spawn points.

## Shutdown

On SIGTERM the server:

1. turns `/readyz` to 503 and refuses new `/ws` connections with 503
   (pending LiveKit removals are dropped: clients reconnect to the next
   process and keep their call);
2. closes every session with WebSocket close 1001 `"server restarting"` and
   waits up to 5 s for the close handshakes, keeping the listener open;
3. stops the HTTP server and exits, 10 s at most after the signal.

Set `terminationGracePeriodSeconds` to at least 15. Clients treat 1001 (and
a refused or dropped connection) as transient and reconnect with
exponential backoff capped at 10 s.

### Node autoscalers

A voluntary eviction disconnects everyone in the office. If a node
autoscaler consolidates or replaces nodes, mark the pod as not disruptible,
for example with Karpenter:

```yaml
metadata:
  annotations:
    karpenter.sh/do-not-disrupt: "true"
```

With spot capacity the pod can still be interrupted; the shutdown above
covers that, within the provider's notice period.

## Behind a proxy

- Terminate TLS at the proxy or ingress and forward plain HTTP to port 8080.
  The browser connects with `wss://` when the page is served over https.
  Set `VB_OFFICE32_PUBLIC_URL` to the https URL users open.
- Allow WebSocket upgrades on `/ws` and forward the original `Host`.
- The server pings every client every 20 s. Idle timeouts on every hop
  (load balancer, ingress, mesh sidecar) must be longer than that; 60 s or
  more is a safe value. Some proxies also cap total stream duration; set that
  to unlimited or to hours for `/ws`.
- Per-connection rate limiting and the global session cap are built in.
  Limits per client IP are not, because the server cannot trust
  `X-Forwarded-For`; apply them at the proxy if needed.

## Kubernetes example

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: vb-office-32
spec:
  replicas: 1
  strategy:
    type: Recreate
  selector:
    matchLabels:
      app: vb-office-32
  template:
    metadata:
      labels:
        app: vb-office-32
      annotations:
        karpenter.sh/do-not-disrupt: "true"
    spec:
      terminationGracePeriodSeconds: 15
      containers:
        - name: vb-office-32
          image: <registry>/vb-office-32:<tag>
          ports:
            - name: http
              containerPort: 8080
          env:
            - name: VB_OFFICE32_LOG_LEVEL
              value: info
            - name: VB_OFFICE32_MAX_SESSIONS
              value: "200"
            - name: VB_OFFICE32_PUBLIC_URL
              value: https://office.example.com
            - name: VB_OFFICE32_ALLOWED_DOMAINS
              value: example.com
          envFrom:
            # VB_OFFICE32_OIDC_CLIENT_ID, VB_OFFICE32_OIDC_CLIENT_SECRET
            # and VB_OFFICE32_SESSION_KEY
            - secretRef:
                name: vb-office-32
          livenessProbe:
            httpGet:
              path: /healthz
              port: http
          readinessProbe:
            httpGet:
              path: /readyz
              port: http
            periodSeconds: 5
          resources:
            requests:
              cpu: 50m
              memory: 64Mi
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop: [ALL]
---
apiVersion: v1
kind: Service
metadata:
  name: vb-office-32
spec:
  selector:
    app: vb-office-32
  ports:
    - name: http
      port: 80
      targetPort: http
```

Route `office.example.com` to this Service through your ingress or gateway,
with TLS terminated there.
