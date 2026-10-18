# syntax=docker/dockerfile:1

# Build stages run on the builder's platform; only the final image is
# per-target, so multi-arch builds need no emulation.
FROM --platform=$BUILDPLATFORM node:22-alpine AS web
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY web/ ./
RUN npm run build

FROM --platform=$BUILDPLATFORM golang:1.25-alpine AS go
ARG TARGETOS TARGETARCH
WORKDIR /src
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY cmd/ cmd/
COPY internal/ internal/
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -trimpath -ldflags="-s -w" -o /out/vb-office-32 ./cmd/vb-office-32

FROM gcr.io/distroless/static-debian12:nonroot
WORKDIR /app
COPY --from=go /out/vb-office-32 /app/vb-office-32
COPY maps/ /app/maps/
COPY --from=web /src/web/dist /app/web/dist
EXPOSE 8080
ENTRYPOINT ["/app/vb-office-32"]
