# .env is parsed by make: plain KEY=value lines, no quotes and no '$'.
-include .env
export

GO      ?= go
BIN     := bin
LOADBOT_FLAGS ?= -n 50 -duration 20s

.PHONY: run test vet lint build loadbot web-dev web-build

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

web-dev:
	cd web && npm run dev

web-build:
	cd web && npm ci && npm run build
