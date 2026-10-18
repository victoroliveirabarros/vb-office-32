package main

import (
	"errors"
	"log/slog"
	"strconv"
	"strings"
)

type config struct {
	addr           string
	mapsDir        string
	webDir         string
	allowedOrigins []string
	maxSessions    int
	logLevel       slog.Level
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
		addr:    env("VB_OFFICE32_ADDR", ":8080"),
		mapsDir: env("VB_OFFICE32_MAPS_DIR", "maps"),
		webDir:  env("VB_OFFICE32_WEB_DIR", "web/dist"),
	}
	for o := range strings.SplitSeq(getenv("VB_OFFICE32_ALLOWED_ORIGINS"), ",") {
		if o = strings.TrimSpace(o); o != "" {
			cfg.allowedOrigins = append(cfg.allowedOrigins, o)
		}
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
	if err := errors.Join(errs...); err != nil {
		return config{}, err
	}
	return cfg, nil
}
