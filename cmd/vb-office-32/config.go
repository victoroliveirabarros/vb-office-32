package main

import (
	"cmp"
	"encoding/base64"
	"errors"
	"log/slog"
	"net/url"
	"strconv"
	"strings"

	"github.com/victoroliveirabarros/vb-office-32/internal/auth"
)

const (
	authOIDC  = "oidc"
	authGuest = "guest"
)

type config struct {
	addr           string
	mapsDir        string
	webDir         string
	allowedOrigins []string
	maxSessions    int
	logLevel       slog.Level
	auth           string
	oidc           auth.OIDCConfig
}

// loadConfig reads VB_OFFICE32_* variables. Errors name the variable but
// never echo its value, so secrets cannot leak into logs.
func loadConfig(getenv func(string) string) (config, error) {
	env := func(key, def string) string {
		if v := getenv(key); v != "" {
			return v
		}
		return def
	}
	cfg := config{
		addr:           env("VB_OFFICE32_ADDR", ":8080"),
		mapsDir:        env("VB_OFFICE32_MAPS_DIR", "maps"),
		webDir:         env("VB_OFFICE32_WEB_DIR", "web/dist"),
		allowedOrigins: splitList(getenv("VB_OFFICE32_ALLOWED_ORIGINS")),
		auth:           env("VB_OFFICE32_AUTH", authOIDC),
	}

	var errs []error
	n, err := strconv.Atoi(env("VB_OFFICE32_MAX_SESSIONS", "200"))
	if err != nil || n < 1 {
		errs = append(errs, errors.New("VB_OFFICE32_MAX_SESSIONS: must be a positive integer"))
	}
	cfg.maxSessions = n
	if err := cfg.logLevel.UnmarshalText([]byte(env("VB_OFFICE32_LOG_LEVEL", "info"))); err != nil {
		errs = append(errs, errors.New("VB_OFFICE32_LOG_LEVEL: must be debug, info, warn or error"))
	}
	switch cfg.auth {
	case authGuest:
	case authOIDC:
		cfg.oidc, err = loadOIDC(getenv)
		errs = append(errs, err)
	default:
		errs = append(errs, errors.New("VB_OFFICE32_AUTH: must be oidc or guest"))
	}
	if err := errors.Join(errs...); err != nil {
		return config{}, err
	}
	return cfg, nil
}

func loadOIDC(getenv func(string) string) (auth.OIDCConfig, error) {
	var errs []error
	required := func(key string) string {
		v := strings.TrimSpace(getenv(key))
		if v == "" {
			errs = append(errs, errors.New(key+": required when VB_OFFICE32_AUTH=oidc"))
		}
		return v
	}
	c := auth.OIDCConfig{
		ClientID:     required("VB_OFFICE32_OIDC_CLIENT_ID"),
		ClientSecret: required("VB_OFFICE32_OIDC_CLIENT_SECRET"),
	}

	if raw := required("VB_OFFICE32_PUBLIC_URL"); raw != "" {
		u, err := url.Parse(raw)
		if err != nil || !validBaseURL(u) || (u.Path != "" && u.Path != "/") {
			errs = append(errs, errors.New("VB_OFFICE32_PUBLIC_URL: must be https://host[:port] without path or query; http only for localhost or 127.0.0.1"))
		} else {
			c.PublicURL = u.Scheme + "://" + u.Host
		}
	}
	// The issuer is kept verbatim: discovery compares it byte for byte.
	c.Issuer = cmp.Or(strings.TrimSpace(getenv("VB_OFFICE32_OIDC_ISSUER")), auth.GoogleIssuer)
	if u, err := url.Parse(c.Issuer); err != nil || !validBaseURL(u) {
		errs = append(errs, errors.New("VB_OFFICE32_OIDC_ISSUER: must be an https URL without query; http only for localhost or 127.0.0.1"))
	}
	if raw := required("VB_OFFICE32_ALLOWED_DOMAINS"); raw != "" {
		for _, d := range splitList(raw) {
			if strings.ContainsAny(d, "@/: \t") || !strings.Contains(d, ".") {
				c.AllowedDomains = nil
				break
			}
			c.AllowedDomains = append(c.AllowedDomains, strings.ToLower(d))
		}
		if len(c.AllowedDomains) == 0 {
			errs = append(errs, errors.New("VB_OFFICE32_ALLOWED_DOMAINS: must list bare domains like example.com"))
		}
	}
	if raw := required("VB_OFFICE32_SESSION_KEY"); raw != "" {
		key, err := base64.StdEncoding.DecodeString(raw)
		if err != nil || len(key) < 32 {
			errs = append(errs, errors.New("VB_OFFICE32_SESSION_KEY: must be standard base64 of at least 32 bytes (openssl rand -base64 32)"))
		}
		c.SessionKey = key
	}
	return c, errors.Join(errs...)
}

// validBaseURL accepts https, or http on loopback for development.
func validBaseURL(u *url.URL) bool {
	if u.Host == "" || u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || u.Opaque != "" {
		return false
	}
	switch u.Scheme {
	case "https":
		return true
	case "http":
		h := u.Hostname()
		return h == "localhost" || h == "127.0.0.1"
	}
	return false
}

func splitList(s string) []string {
	var out []string
	for v := range strings.SplitSeq(s, ",") {
		if v = strings.TrimSpace(v); v != "" {
			out = append(out, v)
		}
	}
	return out
}
