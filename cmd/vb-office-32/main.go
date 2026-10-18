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
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"golang.org/x/sync/errgroup"

	"github.com/victoroliveirabarros/vb-office-32/internal/auth"
	"github.com/victoroliveirabarros/vb-office-32/internal/httpapi"
	"github.com/victoroliveirabarros/vb-office-32/internal/realtime"
	"github.com/victoroliveirabarros/vb-office-32/internal/tilemap"
	"github.com/victoroliveirabarros/vb-office-32/internal/world"
)

const (
	mapID           = "office"
	shutdownTimeout = 10 * time.Second
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := run(ctx, os.Getenv, os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

type config struct {
	addr           string
	mapsDir        string
	webDir         string
	allowedOrigins []string
	logLevel       slog.Level
}

func loadConfig(getenv func(string) string) (config, error) {
	env := func(key, def string) string {
		if v := getenv(key); v != "" {
			return v
		}
		return def
	}
	cfg := config{
		addr:    env("VB_OFFICE32_ADDR", ":8080"),
		mapsDir: env("VB_OFFICE32_MAPS_DIR", "maps"),
		webDir:  env("VB_OFFICE32_WEB_DIR", "web/dist"),
	}
	for o := range strings.SplitSeq(env("VB_OFFICE32_ALLOWED_ORIGINS", "localhost:5173,127.0.0.1:5173"), ",") {
		if o = strings.TrimSpace(o); o != "" {
			cfg.allowedOrigins = append(cfg.allowedOrigins, o)
		}
	}
	if err := cfg.logLevel.UnmarshalText([]byte(env("VB_OFFICE32_LOG_LEVEL", "info"))); err != nil {
		return config{}, fmt.Errorf("VB_OFFICE32_LOG_LEVEL: %w", err)
	}
	return cfg, nil
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
	hub := realtime.NewHub(realtime.NewRoom(realtime.DefaultSpace, mapID, world.NewSpace(m), log))
	ws := realtime.NewHandler(hub, auth.Guest{}, cfg.allowedOrigins, log)
	srv := httpapi.NewServer(httpapi.NewHandler(ws, cfg.mapsDir, cfg.webDir))
	srv.ErrorLog = slog.NewLogLogger(log.Handler(), slog.LevelWarn)

	ln, err := new(net.ListenConfig).Listen(ctx, "tcp", cfg.addr)
	if err != nil {
		return fmt.Errorf("listen: %w", err)
	}
	log.Info("listening", "addr", ln.Addr().String())

	g, gctx := errgroup.WithContext(ctx)
	g.Go(func() error {
		return hub.Run(gctx)
	})
	g.Go(func() error {
		if err := srv.Serve(ln); !errors.Is(err, http.ErrServerClosed) {
			return fmt.Errorf("serve: %w", err)
		}
		return nil
	})
	g.Go(func() error {
		<-gctx.Done()
		sctx, cancel := context.WithTimeout(context.WithoutCancel(gctx), shutdownTimeout)
		defer cancel()
		return srv.Shutdown(sctx)
	})
	if err := g.Wait(); err != nil {
		return err
	}
	log.Info("stopped")
	return nil
}
