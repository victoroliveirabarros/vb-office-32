FROM node:22-alpine AS web
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM golang:1.25-alpine AS go
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd/ cmd/
COPY internal/ internal/
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/vb-office-32 ./cmd/vb-office-32

FROM gcr.io/distroless/static-debian12:nonroot
WORKDIR /app
COPY --from=go /out/vb-office-32 /app/vb-office-32
COPY maps/ /app/maps/
COPY --from=web /src/web/dist /app/web/dist
EXPOSE 8080
ENTRYPOINT ["/app/vb-office-32"]
