package main

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net/http"
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

	res, err := http.Get("http://" + addr + "/healthz")
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Errorf("healthz status = %d, want 200", res.StatusCode)
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

	cancel()
	_, _, err = conn.Read(context.Background())
	if got := websocket.CloseStatus(err); got != websocket.StatusGoingAway {
		t.Errorf("close status on shutdown = %d (%v), want %d", got, err, websocket.StatusGoingAway)
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

func TestRunConfigErrors(t *testing.T) {
	tests := map[string]map[string]string{
		"bad log level": {"VB_OFFICE32_LOG_LEVEL": "loud", "VB_OFFICE32_MAPS_DIR": "../../maps"},
		"missing map":   {"VB_OFFICE32_MAPS_DIR": t.TempDir()},
		"bad addr":      {"VB_OFFICE32_ADDR": "nope:-1", "VB_OFFICE32_MAPS_DIR": "../../maps"},
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
	if len(cfg.allowedOrigins) != 2 || cfg.allowedOrigins[0] != "localhost:5173" || cfg.allowedOrigins[1] != "127.0.0.1:5173" {
		t.Errorf("origins = %v", cfg.allowedOrigins)
	}
}
