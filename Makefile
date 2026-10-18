# .env is parsed by make: plain KEY=value lines, no quotes and no '$'.
-include .env
export

GO      ?= go
BIN     := bin
LOADBOT_FLAGS ?= -n 50 -duration 20s
DEVIDP_FLAGS  ?=

.PHONY: run test vet lint build loadbot web-dev web-build devidp dev-oidc

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

# devidp, the server and Vite together; Ctrl-C stops all three.
dev-oidc:
	@test "$$VB_OFFICE32_AUTH" = oidc && test -n "$$VB_OFFICE32_SESSION_KEY" || \
		{ echo "dev-oidc: .env needs the OIDC block of .env.example with VB_OFFICE32_SESSION_KEY set"; exit 1; }
	$(MAKE) -j3 devidp run web-dev

web-dev:
	cd web && npm run dev

web-build:
	cd web && npm ci && npm run build
