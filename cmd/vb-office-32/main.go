// Command vb-office-32 serves the virtual office.
package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync/atomic"
	"syscall"
	"time"

	"golang.org/x/sync/errgroup"

	"github.com/victoroliveirabarros/vb-office-32/internal/auth"
	"github.com/victoroliveirabarros/vb-office-32/internal/httpapi"
	"github.com/victoroliveirabarros/vb-office-32/internal/media"
	"github.com/victoroliveirabarros/vb-office-32/internal/realtime"
	"github.com/victoroliveirabarros/vb-office-32/internal/tilemap"
	"github.com/victoroliveirabarros/vb-office-32/internal/world"
)

const (
	mapID           = "office"
	shutdownTimeout = 10 * time.Second
	minSecretLen    = 32
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := run(ctx, os.Getenv, os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(ctx context.Context, getenv func(string) string, stdout io.Writer) error {
	cfg, err := loadConfig(getenv)
	if err != nil {
		return err
	}
	log := slog.New(slog.NewJSONHandler(stdout, &slog.HandlerOptions{Level: cfg.logLevel}))

	m, err := tilemap.LoadFile(filepath.Join(cfg.mapsDir, mapID+".tmj"))
	if err != nil {
		return err
	}
	var (
		authn realtime.Authenticator = auth.Guest{}
		login httpapi.OIDC
	)
	if cfg.auth == authOIDC {
		cfg.oidc.Log = log
		o, err := auth.NewOIDC(cfg.oidc)
		if err != nil {
			return fmt.Errorf("oidc: %w", err)
		}
		authn, login = o, o
	} else {
		log.Warn("guest auth: anyone can join under any name; use only for development")
	}

	var (
		mi         realtime.Media
		connectSrc []string
		formAction []string
	)
	if lk := cfg.livekit; lk.url != "" {
		mi = media.NewClient(lk.url, lk.apiKey, lk.apiSecret)
		connectSrc = []string{lk.url, media.HTTPURL(lk.url)}
		if len(lk.apiSecret) < minSecretLen {
			log.Warn("VB_OFFICE32_LIVEKIT_API_SECRET is shorter than 32 characters; use a long random secret outside development")
		}
	}

	var ready atomic.Bool
	if cfg.auth == authOIDC {
		formAction = []string{origin(cfg.oidc.Issuer)}
	}

	hub := realtime.NewHub(realtime.NewRoom(realtime.DefaultSpace, mapID, world.NewSpace(m), mi, log))
	ws := realtime.NewHandler(hub, authn, cfg.allowedOrigins, cfg.maxSessions, log)
	srv := httpapi.NewServer(httpapi.NewHandler(httpapi.Options{
		WS:         ws,
		Ready:      ready.Load,
		MapsDir:    cfg.mapsDir,
		WebDir:     cfg.webDir,
		OIDC:       login,
		ConnectSrc: connectSrc,
		FormAction: formAction,
		HSTS:       strings.HasPrefix(cfg.oidc.PublicURL, "https://"),
	}))
	srv.ErrorLog = slog.NewLogLogger(log.Handler(), slog.LevelWarn)

	ln, err := new(net.ListenConfig).Listen(ctx, "tcp", cfg.addr)
	if err != nil {
		return fmt.Errorf("listen: %w", err)
	}
	log.Info("listening", "addr", ln.Addr().String(), "auth", cfg.auth, "max_sessions", cfg.maxSessions, "media", mi != nil)

	// The hub outlives ctx so sessions are closed only after readiness has
	// turned false, while the listener still answers /readyz with 503.
	hubCtx, stopHub := context.WithCancel(context.WithoutCancel(ctx))
	defer stopHub()
	hubDone := make(chan struct{})

	ready.Store(true)
	g, gctx := errgroup.WithContext(ctx)
	g.Go(func() error {
		defer close(hubDone)
		return hub.Run(hubCtx)
	})
	g.Go(func() error {
		if err := srv.Serve(ln); !errors.Is(err, http.ErrServerClosed) {
			return fmt.Errorf("serve: %w", err)
		}
		return nil
	})
	g.Go(func() error {
		<-gctx.Done()
		ready.Store(false)
		log.Info("shutting down")
		sctx, cancel := context.WithTimeout(context.WithoutCancel(gctx), shutdownTimeout)
		defer cancel()
		stopHub()
		select {
		case <-hubDone:
		case <-sctx.Done():
		}
		return srv.Shutdown(sctx)
	})
	if err := g.Wait(); err != nil {
		return err
	}
	log.Info("stopped")
	return nil
}

// origin keeps the scheme and host of a URL loadConfig already validated.
func origin(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	return u.Scheme + "://" + u.Host
}
