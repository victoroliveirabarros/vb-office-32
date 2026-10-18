# .env is parsed by make: plain KEY=value lines, no quotes and no '$'.
-include .env
export

GO      ?= go
BIN     := bin
LOADBOT_FLAGS ?= -n 50 -duration 20s
DEVIDP_FLAGS  ?=
LIVEKIT_IMAGE ?= livekit/livekit-server:v1.13

.PHONY: run test vet lint build loadbot web-dev web-build devidp dev-oidc livekit

run:
	$(GO) run ./cmd/vb-office-32

test:
	$(GO) test -race ./...

vet:
	$(GO) vet ./...

lint:
	@if command -v golangci-lint >/dev/null 2>&1; then \
		golangci-lint run ./...; \
	else \
		echo "golangci-lint not installed, skipping"; \
	fi

build:
	CGO_ENABLED=0 $(GO) build -trimpath -o $(BIN)/ ./cmd/...

loadbot:
	$(GO) run ./cmd/loadbot $(LOADBOT_FLAGS)

# Development OIDC provider on 127.0.0.1:9000; never deploy it.
devidp:
	$(GO) run ./cmd/devidp $(DEVIDP_FLAGS)

# LiveKit in development mode (key devkey, secret secret) on :7880. Host
# networking works on Linux only; see docs/livekit.md for other systems.
livekit:
	docker run --rm --name vb-office-32-livekit --network host $(LIVEKIT_IMAGE) --dev --bind 127.0.0.1

# devidp, the server and Vite together, plus LiveKit when
# VB_OFFICE32_LIVEKIT_URL is set; Ctrl-C stops them all.
DEV_OIDC := devidp run web-dev $(if $(VB_OFFICE32_LIVEKIT_URL),livekit)
dev-oidc:
	@test "$$VB_OFFICE32_AUTH" = oidc && test -n "$$VB_OFFICE32_SESSION_KEY" || \
		{ echo "dev-oidc: .env needs the OIDC block of .env.example with VB_OFFICE32_SESSION_KEY set"; exit 1; }
	$(MAKE) -j$(words $(DEV_OIDC)) $(DEV_OIDC)

web-dev:
	cd web && npm run dev

web-build:
	cd web && npm ci && npm run build
