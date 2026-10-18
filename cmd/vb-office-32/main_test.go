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

// start runs the server until ctx is done and returns its address.
func start(t *testing.T, ctx context.Context, vars map[string]string) (string, <-chan error) {
	t.Helper()
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

	vars["VB_OFFICE32_ADDR"] = "127.0.0.1:0"
	vars["VB_OFFICE32_MAPS_DIR"] = "../../maps"
	vars["VB_OFFICE32_WEB_DIR"] = t.TempDir()
	vars["VB_OFFICE32_LOG_LEVEL"] = "debug"
	errc := make(chan error, 1)
	go func() {
		errc <- run(ctx, env(vars), pw)
		pw.Close()
	}()

	select {
	case addr := <-addrs:
		return addr, errc
	case err := <-errc:
		t.Fatalf("run exited early: %v", err)
	case <-time.After(5 * time.Second):
		t.Fatal("server did not start")
	}
	return "", nil
}

func TestRun(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	addr, errc := start(t, ctx, map[string]string{"VB_OFFICE32_AUTH": "guest"})

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

func TestRunOIDC(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	// The issuer is unreachable: boot must not depend on it.
	addr, errc := start(t, ctx, oidcEnv())

	res, err := http.Get("http://" + addr + "/api/session")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if res.StatusCode != http.StatusUnauthorized || string(body) != `{"auth":"oidc"}`+"\n" {
		t.Errorf("/api/session = %d %s", res.StatusCode, body)
	}
	if got := status(t, "http://"+addr+"/auth/login"); got != http.StatusServiceUnavailable {
		t.Errorf("/auth/login with provider down = %d, want 503", got)
	}
	_, res, err = websocket.Dial(ctx, "ws://"+addr+"/ws?name=ana", nil)
	if err == nil || res == nil || res.StatusCode != http.StatusUnauthorized {
		t.Errorf("dial without session: res = %v, err = %v, want 401", res, err)
	}

	cancel()
	if err := <-errc; err != nil {
		t.Errorf("run: %v", err)
	}
}

func oidcEnv() map[string]string {
	return map[string]string{
		"VB_OFFICE32_PUBLIC_URL":         "http://localhost:5173",
		"VB_OFFICE32_OIDC_ISSUER":        "http://127.0.0.1:1",
		"VB_OFFICE32_OIDC_CLIENT_ID":     "client",
		"VB_OFFICE32_OIDC_CLIENT_SECRET": "secret",
		"VB_OFFICE32_ALLOWED_DOMAINS":    "Example.com, example.org",
		"VB_OFFICE32_SESSION_KEY":        "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
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
		"bad log level":    {"VB_OFFICE32_AUTH": "guest", "VB_OFFICE32_LOG_LEVEL": "loud", "VB_OFFICE32_MAPS_DIR": "../../maps"},
		"bad max sessions": {"VB_OFFICE32_AUTH": "guest", "VB_OFFICE32_MAX_SESSIONS": "0", "VB_OFFICE32_MAPS_DIR": "../../maps"},
		"missing map":      {"VB_OFFICE32_AUTH": "guest", "VB_OFFICE32_MAPS_DIR": t.TempDir()},
		"bad addr":         {"VB_OFFICE32_AUTH": "guest", "VB_OFFICE32_ADDR": "nope:-1", "VB_OFFICE32_MAPS_DIR": "../../maps"},
		"oidc unset":       {"VB_OFFICE32_MAPS_DIR": "../../maps"},
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
	cfg, err := loadConfig(env(map[string]string{"VB_OFFICE32_AUTH": "guest"}))
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
		"VB_OFFICE32_AUTH":            "guest",
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
		"VB_OFFICE32_MAX_SESSIONS":    "s3cr3t-sessions",
		"VB_OFFICE32_LOG_LEVEL":       "s3cr3t-level",
		"VB_OFFICE32_PUBLIC_URL":      "http://s3cr3t.example",
		"VB_OFFICE32_OIDC_ISSUER":     "ftp://s3cr3t.example",
		"VB_OFFICE32_ALLOWED_DOMAINS": "s3cr3t@example.com",
		"VB_OFFICE32_SESSION_KEY":     "s3cr3t-key",
	}))
	if err == nil {
		t.Fatal("loadConfig succeeded, want error")
	}
	msg := err.Error()
	for _, want := range []string{
		"VB_OFFICE32_MAX_SESSIONS", "VB_OFFICE32_LOG_LEVEL", "VB_OFFICE32_PUBLIC_URL", "VB_OFFICE32_OIDC_ISSUER",
		"VB_OFFICE32_ALLOWED_DOMAINS", "VB_OFFICE32_SESSION_KEY", "VB_OFFICE32_OIDC_CLIENT_ID", "VB_OFFICE32_OIDC_CLIENT_SECRET",
	} {
		if !strings.Contains(msg, want) {
			t.Errorf("error %q does not name %s", msg, want)
		}
	}
	if strings.Contains(msg, "s3cr3t") {
		t.Errorf("error %q echoes the value", msg)
	}
}

func TestLoadConfigOIDC(t *testing.T) {
	vars := oidcEnv()
	vars["VB_OFFICE32_PUBLIC_URL"] = "https://office.example/"
	delete(vars, "VB_OFFICE32_OIDC_ISSUER")
	cfg, err := loadConfig(env(vars))
	if err != nil {
		t.Fatal(err)
	}
	o := cfg.oidc
	if cfg.auth != "oidc" || o.PublicURL != "https://office.example" || o.Issuer != "https://accounts.google.com" ||
		o.ClientID != "client" || o.ClientSecret != "secret" || len(o.SessionKey) != 32 ||
		!slices.Equal(o.AllowedDomains, []string{"example.com", "example.org"}) {
		t.Errorf("oidc config = %+v", o)
	}
}

func TestLoadConfigOIDCRequired(t *testing.T) {
	required := []string{
		"VB_OFFICE32_PUBLIC_URL", "VB_OFFICE32_OIDC_CLIENT_ID", "VB_OFFICE32_OIDC_CLIENT_SECRET",
		"VB_OFFICE32_ALLOWED_DOMAINS", "VB_OFFICE32_SESSION_KEY",
	}
	for _, key := range required {
		t.Run(key, func(t *testing.T) {
			vars := oidcEnv()
			delete(vars, key)
			_, err := loadConfig(env(vars))
			if err == nil || !strings.Contains(err.Error(), key) {
				t.Errorf("err = %v, want one naming %s", err, key)
			}
		})
	}
	if _, err := loadConfig(env(map[string]string{"VB_OFFICE32_AUTH": "none"})); err == nil || !strings.Contains(err.Error(), "VB_OFFICE32_AUTH") {
		t.Errorf("unknown auth mode: err = %v", err)
	}
}

func TestLoadConfigOIDCValues(t *testing.T) {
	tests := []struct {
		key, value string
		ok         bool
	}{
		{"VB_OFFICE32_PUBLIC_URL", "https://office.example", true},
		{"VB_OFFICE32_PUBLIC_URL", "https://office.example:8443/", true},
		{"VB_OFFICE32_PUBLIC_URL", "http://localhost:5173", true},
		{"VB_OFFICE32_PUBLIC_URL", "http://127.0.0.1:8080", true},
		{"VB_OFFICE32_PUBLIC_URL", "http://office.example", false},
		{"VB_OFFICE32_PUBLIC_URL", "http://localhost.evil.example", false},
		{"VB_OFFICE32_PUBLIC_URL", "https://office.example/app", false},
		{"VB_OFFICE32_PUBLIC_URL", "https://office.example/?x=1", false},
		{"VB_OFFICE32_PUBLIC_URL", "https://office.example/?", false},
		{"VB_OFFICE32_PUBLIC_URL", "https://office.example#top", false},
		{"VB_OFFICE32_PUBLIC_URL", "https://user@office.example", false},
		{"VB_OFFICE32_PUBLIC_URL", "office.example", false},
		{"VB_OFFICE32_PUBLIC_URL", "https://", false},
		{"VB_OFFICE32_PUBLIC_URL", "ws://localhost:5173", false},
		{"VB_OFFICE32_PUBLIC_URL", "https://:443", false},
		{"VB_OFFICE32_PUBLIC_URL", "https://office.example:0", false},
		{"VB_OFFICE32_PUBLIC_URL", "https://office.example:65536", false},
		{"VB_OFFICE32_PUBLIC_URL", "https://office.example:", false},
		{"VB_OFFICE32_PUBLIC_URL", "https://office.example:65535", true},
		{"VB_OFFICE32_OIDC_ISSUER", "https://cognito-idp.us-east-1.amazonaws.com/pool", true},
		{"VB_OFFICE32_OIDC_ISSUER", "http://issuer.example", false},
		{"VB_OFFICE32_OIDC_ISSUER", "https://issuer.example?tenant=1", false},
		{"VB_OFFICE32_OIDC_ISSUER", "https://:443/pool", false},
		{"VB_OFFICE32_OIDC_ISSUER", "https://issuer.example:99999", false},
		{"VB_OFFICE32_ALLOWED_DOMAINS", "example.com,example.org", true},
		{"VB_OFFICE32_ALLOWED_DOMAINS", "@example.com", false},
		{"VB_OFFICE32_ALLOWED_DOMAINS", "example", false},
		{"VB_OFFICE32_ALLOWED_DOMAINS", " , ", false},
		{"VB_OFFICE32_SESSION_KEY", "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=\n", true},
		{"VB_OFFICE32_SESSION_KEY", "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZQ==", false},
		{"VB_OFFICE32_SESSION_KEY", "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY", false},
	}
	for _, tt := range tests {
		t.Run(tt.key+"="+tt.value, func(t *testing.T) {
			vars := oidcEnv()
			vars[tt.key] = tt.value
			_, err := loadConfig(env(vars))
			if tt.ok != (err == nil) {
				t.Fatalf("err = %v, want ok = %v", err, tt.ok)
			}
			if err != nil && !strings.Contains(err.Error(), tt.key) {
				t.Errorf("err = %v, want one naming %s", err, tt.key)
			}
		})
	}
}

func livekitEnv() map[string]string {
	return map[string]string{
		"VB_OFFICE32_AUTH":               "guest",
		"VB_OFFICE32_LIVEKIT_URL":        "ws://localhost:7880",
		"VB_OFFICE32_LIVEKIT_API_KEY":    "devkey",
		"VB_OFFICE32_LIVEKIT_API_SECRET": "secret",
	}
}

func TestRunWithMedia(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	addr, errc := start(t, ctx, livekitEnv())

	conn, _, err := websocket.Dial(ctx, "ws://"+addr+"/ws?name=ana", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.CloseNow()
	var types []string
	var grant struct {
		URL       string `json:"url"`
		Token     string `json:"token"`
		ExpiresAt int64  `json:"expiresAt"`
	}
	for range 3 {
		_, msg, err := conn.Read(ctx)
		if err != nil {
			t.Fatal(err)
		}
		var env struct {
			T string          `json:"t"`
			D json.RawMessage `json:"d"`
		}
		if err := json.Unmarshal(msg, &env); err != nil {
			t.Fatal(err)
		}
		types = append(types, env.T)
		if env.T == "media" {
			if err := json.Unmarshal(env.D, &grant); err != nil {
				t.Fatal(err)
			}
		}
	}
	if !slices.Equal(types, []string{"welcome", "media", "nearby"}) {
		t.Errorf("first messages = %v, want welcome, media, nearby", types)
	}
	if grant.URL != "ws://localhost:7880" || strings.Count(grant.Token, ".") != 2 {
		t.Errorf("media = %+v", grant)
	}
	if left := time.Until(time.UnixMilli(grant.ExpiresAt)); left < 9*time.Minute || left > 10*time.Minute {
		t.Errorf("grant expires in %v, want 10m", left)
	}

	cancel()
	if err := <-errc; err != nil {
		t.Errorf("run: %v", err)
	}
}

func TestLoadConfigLiveKit(t *testing.T) {
	cfg, err := loadConfig(env(livekitEnv()))
	if err != nil {
		t.Fatal(err)
	}
	if want := (livekitConfig{"ws://localhost:7880", "devkey", "secret"}); cfg.livekit != want {
		t.Errorf("livekit = %+v, want %+v", cfg.livekit, want)
	}
	cfg, err = loadConfig(env(map[string]string{"VB_OFFICE32_AUTH": "guest"}))
	if err != nil || cfg.livekit != (livekitConfig{}) {
		t.Errorf("without variables: livekit = %+v, err = %v, want media off", cfg.livekit, err)
	}

	for _, key := range []string{"VB_OFFICE32_LIVEKIT_URL", "VB_OFFICE32_LIVEKIT_API_KEY", "VB_OFFICE32_LIVEKIT_API_SECRET"} {
		t.Run("without "+key, func(t *testing.T) {
			vars := livekitEnv()
			vars["VB_OFFICE32_LIVEKIT_API_SECRET"] = "s3cr3t"
			delete(vars, key)
			_, err := loadConfig(env(vars))
			if err == nil || !strings.Contains(err.Error(), key) {
				t.Fatalf("err = %v, want one naming %s", err, key)
			}
			if strings.Contains(err.Error(), "s3cr3t") {
				t.Errorf("error %q echoes the secret", err)
			}
		})
	}

	tests := []struct {
		value string
		want  string
	}{
		{"wss://media.example", "wss://media.example"},
		{"wss://media.example:7880/", "wss://media.example:7880"},
		{"ws://localhost:7880", "ws://localhost:7880"},
		{"ws://127.0.0.1:7880", "ws://127.0.0.1:7880"},
		{"ws://media.example", ""},
		{"https://media.example", ""},
		{"wss://media.example/rtc", ""},
		{"wss://media.example?x=1", ""},
		{"wss://user:s3cr3t@media.example", ""},
		{"media.example", ""},
		{"wss://:443", ""},
		{"wss://media.example:99999", ""},
		{"wss://media.example:0", ""},
		{"wss://media.example:443", "wss://media.example:443"},
	}
	for _, tt := range tests {
		t.Run(tt.value, func(t *testing.T) {
			vars := livekitEnv()
			vars["VB_OFFICE32_LIVEKIT_URL"] = tt.value
			cfg, err := loadConfig(env(vars))
			if tt.want == "" {
				if err == nil || !strings.Contains(err.Error(), "VB_OFFICE32_LIVEKIT_URL") || strings.Contains(err.Error(), "s3cr3t") {
					t.Errorf("err = %v, want one naming VB_OFFICE32_LIVEKIT_URL without its value", err)
				}
				return
			}
			if err != nil || cfg.livekit.url != tt.want {
				t.Errorf("url = %q, err = %v, want %q", cfg.livekit.url, err, tt.want)
			}
		})
	}
}
