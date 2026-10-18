// Command devidp is an OpenID Connect provider for local development. It
// signs in anyone who fills its form, so it only listens on loopback.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"syscall"
	"time"
)

const shutdownTimeout = 5 * time.Second

func main() {
	var (
		cfg  config
		addr string
	)
	flag.StringVar(&addr, "addr", envOr("DEVIDP_ADDR", "127.0.0.1:9000"), "loopback listen address (env DEVIDP_ADDR)")
	flag.StringVar(&cfg.issuer, "issuer", envOr("DEVIDP_ISSUER", "http://localhost:9000"), "issuer URL; must match the server's OIDC issuer (env DEVIDP_ISSUER)")
	flag.StringVar(&cfg.clientID, "client-id", envOr("DEVIDP_CLIENT_ID", "dev-client"), "accepted client ID (env DEVIDP_CLIENT_ID)")
	flag.StringVar(&cfg.clientSecret, "client-secret", envOr("DEVIDP_CLIENT_SECRET", "dev-secret"), "accepted client secret (env DEVIDP_CLIENT_SECRET)")
	flag.StringVar(&cfg.redirectURI, "redirect", envOr("DEVIDP_REDIRECT", "http://localhost:5173/auth/callback"), "accepted redirect URI (env DEVIDP_REDIRECT)")
	flag.Parse()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	log := slog.New(slog.NewTextHandler(os.Stderr, nil))
	if err := run(ctx, addr, cfg, log); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(ctx context.Context, addr string, cfg config, log *slog.Logger) error {
	if err := checkLoopback(addr); err != nil {
		return err
	}
	if u, err := url.Parse(cfg.issuer); err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return errors.New("-issuer: must be an http(s) URL")
	}
	p, err := newProvider(cfg, log)
	if err != nil {
		return err
	}
	ln, err := new(net.ListenConfig).Listen(ctx, "tcp", addr)
	if err != nil {
		return fmt.Errorf("listen: %w", err)
	}
	// localhost could resolve elsewhere; the bound address is what counts.
	if ip := ln.Addr().(*net.TCPAddr).IP; !ip.IsLoopback() {
		ln.Close()
		return fmt.Errorf("-addr: bound to non-loopback %s", ip)
	}
	log.Warn("devidp: development only; it signs in anyone who fills the form, never expose it",
		"addr", ln.Addr().String(), "issuer", cfg.issuer, "client_id", cfg.clientID, "redirect", cfg.redirectURI)

	srv := &http.Server{
		Handler:           p.handler(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      10 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
	errc := make(chan error, 1)
	go func() { errc <- srv.Serve(ln) }()
	select {
	case err := <-errc:
		return fmt.Errorf("serve: %w", err)
	case <-ctx.Done():
	}
	sctx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
	defer cancel()
	return srv.Shutdown(sctx)
}

// checkLoopback accepts only localhost or a loopback IP; an empty host
// would listen on every interface.
func checkLoopback(addr string) error {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return fmt.Errorf("-addr: %w", err)
	}
	if host == "localhost" {
		return nil
	}
	if ip := net.ParseIP(host); ip == nil || !ip.IsLoopback() {
		return fmt.Errorf("-addr: %q is not a loopback address; devidp must not be reachable from the network", addr)
	}
	return nil
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
