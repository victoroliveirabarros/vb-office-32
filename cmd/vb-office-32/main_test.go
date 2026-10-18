package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func env(vars map[string]string) func(string) string {
	return func(k string) string { return vars[k] }
}

func TestRun(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	pr, pw := io.Pipe()
	addrs := make(chan string, 1)
	go func() {
		sc := bufio.NewScanner(pr)
		for sc.Scan() {
			var line struct{ Msg, Addr string }
			if json.Unmarshal(sc.Bytes(), &line) == nil && line.Msg == "listening" {
				addrs <- line.Addr
			}
		}
	}()

	errc := make(chan error, 1)
	go func() {
		errc <- run(ctx, env(map[string]string{
			"VB_OFFICE32_ADDR":      "127.0.0.1:0",
			"VB_OFFICE32_MAPS_DIR":  "../../maps",
			"VB_OFFICE32_WEB_DIR":   t.TempDir(),
			"VB_OFFICE32_LOG_LEVEL": "debug",
		}), pw)
		pw.Close()
	}()

	var addr string
	select {
	case addr = <-addrs:
	case err := <-errc:
		t.Fatalf("run exited early: %v", err)
	case <-time.After(5 * time.Second):
		t.Fatal("server did not start")
	}

	for _, path := range []string{"/healthz", "/readyz"} {
		if got := status(t, "http://"+addr+path); got != http.StatusOK {
			t.Errorf("%s status = %d, want 200", path, got)
		}
	}

	conn, _, err := websocket.Dial(ctx, "ws://"+addr+"/ws?name=ana", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.CloseNow()
	_, msg, err := conn.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var welcome struct {
		T string `json:"t"`
		D struct {
			SelfID string `json:"selfId"`
			MapID  string `json:"mapId"`
		} `json:"d"`
	}
	if err := json.Unmarshal(msg, &welcome); err != nil {
		t.Fatal(err)
	}
	if welcome.T != "welcome" || welcome.D.SelfID != "guest:ana" || welcome.D.MapID != "office" {
		t.Errorf("first message = %s", msg)
	}

	// The open session is not read until the checks below are done, so its
	// close handshake keeps the server draining meanwhile.
	cancel()
	deadline := time.Now().Add(2 * time.Second)
	for status(t, "http://"+addr+"/readyz") != http.StatusServiceUnavailable {
		if time.Now().After(deadline) {
			t.Fatal("readyz still ready after shutdown started")
		}
		time.Sleep(5 * time.Millisecond)
	}
	if got := status(t, "http://"+addr+"/healthz"); got != http.StatusOK {
		t.Errorf("healthz while draining = %d, want 200", got)
	}
	_, res, err := websocket.Dial(context.Background(), "ws://"+addr+"/ws?name=bob", nil)
	if err == nil || res == nil || res.StatusCode != http.StatusServiceUnavailable {
		t.Errorf("dial while draining: res = %v, err = %v, want 503", res, err)
	}

	_, _, err = conn.Read(context.Background())
	var ce websocket.CloseError
	if !errors.As(err, &ce) || ce.Code != websocket.StatusGoingAway || ce.Reason != "server restarting" {
		t.Errorf("close on shutdown = %v, want 1001 \"server restarting\"", err)
	}
	select {
	case err := <-errc:
		if err != nil {
			t.Errorf("run: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("run did not stop after cancel")
	}
}

func status(t *testing.T, url string) int {
	t.Helper()
	res, err := http.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	return res.StatusCode
}

func TestRunConfigErrors(t *testing.T) {
	tests := map[string]map[string]string{
		"bad log level":    {"VB_OFFICE32_LOG_LEVEL": "loud", "VB_OFFICE32_MAPS_DIR": "../../maps"},
		"bad max sessions": {"VB_OFFICE32_MAX_SESSIONS": "0", "VB_OFFICE32_MAPS_DIR": "../../maps"},
		"missing map":      {"VB_OFFICE32_MAPS_DIR": t.TempDir()},
		"bad addr":         {"VB_OFFICE32_ADDR": "nope:-1", "VB_OFFICE32_MAPS_DIR": "../../maps"},
	}
	for name, vars := range tests {
		t.Run(name, func(t *testing.T) {
			if err := run(context.Background(), env(vars), io.Discard); err == nil {
				t.Fatal("run succeeded, want error")
			}
		})
	}
}

func TestLoadConfigDefaults(t *testing.T) {
	cfg, err := loadConfig(env(nil))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.addr != ":8080" || cfg.mapsDir != "maps" || cfg.webDir != "web/dist" {
		t.Errorf("config = %+v", cfg)
	}
	if cfg.allowedOrigins != nil || cfg.maxSessions != 200 {
		t.Errorf("config = %+v, want no extra origins and 200 sessions", cfg)
	}
}

func TestLoadConfig(t *testing.T) {
	cfg, err := loadConfig(env(map[string]string{
		"VB_OFFICE32_ALLOWED_ORIGINS": " localhost:5173 ,,127.0.0.1:5173",
		"VB_OFFICE32_MAX_SESSIONS":    "3",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(cfg.allowedOrigins, []string{"localhost:5173", "127.0.0.1:5173"}) || cfg.maxSessions != 3 {
		t.Errorf("config = %+v", cfg)
	}
}

func TestLoadConfigErrorsNameVariableNotValue(t *testing.T) {
	_, err := loadConfig(env(map[string]string{
		"VB_OFFICE32_MAX_SESSIONS": "s3cr3t-sessions",
		"VB_OFFICE32_LOG_LEVEL":    "s3cr3t-level",
	}))
	if err == nil {
		t.Fatal("loadConfig succeeded, want error")
	}
	msg := err.Error()
	for _, want := range []string{"VB_OFFICE32_MAX_SESSIONS", "VB_OFFICE32_LOG_LEVEL"} {
		if !strings.Contains(msg, want) {
			t.Errorf("error %q does not name %s", msg, want)
		}
	}
	if strings.Contains(msg, "s3cr3t") {
		t.Errorf("error %q echoes the value", msg)
	}
}
