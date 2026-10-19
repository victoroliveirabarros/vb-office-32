package httpapi

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/victoroliveirabarros/vb-office-32/internal/auth"
)

type fakeOIDC struct{}

func (fakeOIDC) Authenticate(r *http.Request) (auth.Identity, error) {
	if c, err := r.Cookie("s"); err == nil && c.Value == "ok" {
		return auth.Identity{ID: "oidc:42", Name: "Zé", Expires: time.Now().Add(time.Hour)}, nil
	}
	return auth.Identity{}, errors.New("no session")
}

func (fakeOIDC) Login(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusFound) }
func (fakeOIDC) Callback(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Referrer-Policy", "same-origin")
	w.WriteHeader(http.StatusSeeOther)
}
func (fakeOIDC) Logout(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) }

func TestHandler(t *testing.T) {
	maps, web := t.TempDir(), t.TempDir()
	noIndex := t.TempDir()
	write := func(dir, name, body string) {
		path := filepath.Join(dir, name)
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write(maps, "office.tmj", `{"type":"map"}`)
	write(maps, "old/office.tmj", `{"type":"map"}`)
	write(web, "index.html", "<html>office</html>")
	write(web, "assets/app.js", "app")
	write(web, "nested/index.html", "<html>nested</html>")
	write(noIndex, "app.js", "app")
	ws := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusTeapot) })
	ready := func() bool { return true }
	notReady := func() bool { return false }
	h := NewHandler(Options{WS: ws, Ready: ready, MapsDir: maps, WebDir: web})
	noWeb := NewHandler(Options{WS: ws, Ready: ready, MapsDir: maps, WebDir: filepath.Join(web, "missing")})
	noIndexWeb := NewHandler(Options{WS: ws, Ready: ready, MapsDir: maps, WebDir: noIndex})
	draining := NewHandler(Options{WS: ws, Ready: notReady, MapsDir: maps, WebDir: web})
	oidc := NewHandler(Options{WS: ws, Ready: ready, MapsDir: maps, WebDir: web, OIDC: fakeOIDC{}})
	session := http.Header{"Cookie": {"s=ok"}}

	tests := []struct {
		name        string
		h           http.Handler
		method      string
		path        string
		header      http.Header
		status      int
		body        string
		contentType string
	}{
		{"healthz", h, "GET", "/healthz", nil, 200, "ok\n", "text/plain; charset=utf-8"},
		{"readyz", h, "GET", "/readyz", nil, 200, "ok\n", "text/plain; charset=utf-8"},
		{"websocket", h, "GET", "/ws", nil, http.StatusTeapot, "", ""},
		{"draining healthz", draining, "GET", "/healthz", nil, 200, "ok\n", ""},
		{"draining readyz", draining, "GET", "/readyz", nil, 503, "shutting down\n", ""},
		{"draining websocket", draining, "GET", "/ws", nil, 503, "shutting down\n", ""},
		{"draining web", draining, "GET", "/", nil, 200, "<html>office</html>", ""},
		{"map", h, "GET", "/maps/office.tmj", nil, 200, `{"type":"map"}`, "application/json"},
		{"missing map", h, "GET", "/maps/nope.tmj", nil, 404, "", ""},
		{"maps dir", h, "GET", "/maps/", nil, 404, "", ""},
		{"maps subdir", h, "GET", "/maps/old/", nil, 404, "", ""},
		{"maps subdir no slash", h, "GET", "/maps/old", nil, 404, "", ""},
		{"web index", h, "GET", "/", nil, 200, "<html>office</html>", "text/html; charset=utf-8"},
		{"web asset", h, "GET", "/assets/app.js", nil, 200, "app", ""},
		{"web subdir", h, "GET", "/assets/", nil, 404, "", ""},
		{"web subdir no slash", h, "GET", "/assets", nil, 404, "", ""},
		{"web subdir with index", h, "GET", "/nested/", nil, 404, "", ""},
		{"web root without index", noIndexWeb, "GET", "/", nil, 404, "", ""},
		{"missing web dir", noWeb, "GET", "/", nil, 404, "", ""},
		{"wrong method", h, "POST", "/healthz", nil, http.StatusMethodNotAllowed, "", ""},
		{"cross-site post", h, "POST", "/healthz", http.Header{"Sec-Fetch-Site": {"cross-site"}}, http.StatusForbidden, "", ""},
		{"cross-origin post", h, "POST", "/healthz", http.Header{"Origin": {"https://evil.example"}}, http.StatusForbidden, "", ""},
		{"cross-site get", h, "GET", "/healthz", http.Header{"Sec-Fetch-Site": {"cross-site"}}, 200, "ok\n", ""},
		{"guest session", h, "GET", "/api/session", session, 401, `{"auth":"guest"}` + "\n", "application/json"},
		{"guest login route", h, "GET", "/auth/login", nil, 404, "", ""},
		{"guest logout route", h, "POST", "/auth/logout", nil, http.StatusMethodNotAllowed, "", ""},
		{"oidc no session", oidc, "GET", "/api/session", nil, 401, `{"auth":"oidc"}` + "\n", "application/json"},
		{"oidc session", oidc, "GET", "/api/session", session, 200, `{"id":"oidc:42","name":"Zé","auth":"oidc"}` + "\n", "application/json"},
		{"oidc login", oidc, "GET", "/auth/login", nil, http.StatusFound, "", ""},
		{"oidc callback", oidc, "GET", "/auth/callback?code=x&state=y", nil, http.StatusSeeOther, "", ""},
		{"oidc logout", oidc, "POST", "/auth/logout", http.Header{"Sec-Fetch-Site": {"same-origin"}}, http.StatusNoContent, "", ""},
		{"oidc logout by get", oidc, "GET", "/auth/logout", nil, 404, "", ""},
		{"oidc logout cross-site", oidc, "POST", "/auth/logout", http.Header{"Sec-Fetch-Site": {"cross-site"}}, http.StatusForbidden, "", ""},
		{"oidc logout cross-origin", oidc, "POST", "/auth/logout", http.Header{"Origin": {"https://evil.example"}}, http.StatusForbidden, "", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			req := httptest.NewRequest(tt.method, tt.path, nil)
			for k, v := range tt.header {
				req.Header[k] = v
			}
			tt.h.ServeHTTP(rec, req)
			res := rec.Result()
			body, _ := io.ReadAll(res.Body)

			if res.StatusCode != tt.status {
				t.Errorf("status = %d, want %d", res.StatusCode, tt.status)
			}
			if tt.body != "" && string(body) != tt.body {
				t.Errorf("body = %q, want %q", body, tt.body)
			}
			if got := res.Header.Get("Content-Type"); tt.contentType != "" && got != tt.contentType {
				t.Errorf("content type = %q, want %q", got, tt.contentType)
			}
			if got := res.Header.Get("Cache-Control"); tt.path == "/api/session" && got != "no-store" {
				t.Errorf("cache control = %q, want no-store", got)
			}
		})
	}
}

func TestSecurityHeaders(t *testing.T) {
	web := t.TempDir()
	if err := os.WriteFile(filepath.Join(web, "index.html"), []byte("<html></html>"), 0o644); err != nil {
		t.Fatal(err)
	}
	ws := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusTeapot) })
	ready := func() bool { return true }
	const base = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; " +
		"media-src 'self'; connect-src 'self'%s; font-src 'self'; object-src 'none'; base-uri 'none'; " +
		"form-action 'self'; frame-ancestors 'none'"

	tests := []struct {
		name string
		opts Options
		csp  string
		hsts bool
	}{
		{"guest without media", Options{}, fmt.Sprintf(base, ""), false},
		{
			"oidc with media over https",
			Options{
				OIDC:       fakeOIDC{},
				ConnectSrc: []string{"wss://media.example", "https://media.example"},
				HSTS:       true,
			},
			fmt.Sprintf(base, " wss://media.example https://media.example"),
			true,
		},
	}
	for _, tt := range tests {
		tt.opts.WS, tt.opts.Ready, tt.opts.MapsDir, tt.opts.WebDir = ws, ready, t.TempDir(), web
		h := NewHandler(tt.opts)
		for _, path := range []string{"/", "/index.html", "/missing.js", "/api/session", "/healthz", "/maps/office.tmj"} {
			t.Run(tt.name+" "+path, func(t *testing.T) {
				rec := httptest.NewRecorder()
				h.ServeHTTP(rec, httptest.NewRequest("GET", path, nil))
				want := map[string]string{
					"Content-Security-Policy":    tt.csp,
					"X-Content-Type-Options":     "nosniff",
					"Referrer-Policy":            "no-referrer",
					"Permissions-Policy":         "camera=(self), microphone=(self), geolocation=(), display-capture=()",
					"Cross-Origin-Opener-Policy": "same-origin",
					"Strict-Transport-Security":  "",
				}
				if tt.hsts {
					want["Strict-Transport-Security"] = "max-age=31536000"
				}
				for k, v := range want {
					if got := rec.Header().Get(k); got != v {
						t.Errorf("%s = %q, want %q", k, got, v)
					}
				}
			})
		}
	}

	t.Run("handlers override", func(t *testing.T) {
		h := NewHandler(Options{WS: ws, Ready: ready, MapsDir: t.TempDir(), WebDir: web, OIDC: fakeOIDC{}})
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest("GET", "/auth/callback", nil))
		if got := rec.Header().Get("Referrer-Policy"); got != "same-origin" {
			t.Errorf("Referrer-Policy = %q, want the handler's own", got)
		}
		if rec.Header().Get("Content-Security-Policy") == "" {
			t.Error("no Content-Security-Policy on an auth page")
		}
	})
}

func TestMediaWebhookRoute(t *testing.T) {
	hook := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusAccepted) })
	opts := Options{Ready: func() bool { return true }, MapsDir: t.TempDir(), WebDir: t.TempDir()}
	without := NewHandler(opts)
	opts.MediaWebhook = hook
	with := NewHandler(opts)

	for _, tt := range []struct {
		h      http.Handler
		method string
		want   int
	}{
		{with, http.MethodPost, http.StatusAccepted},
		{with, http.MethodGet, http.StatusNotFound},
		{without, http.MethodPost, http.StatusMethodNotAllowed},
	} {
		rec := httptest.NewRecorder()
		// LiveKit sends neither Origin nor Sec-Fetch-Site.
		tt.h.ServeHTTP(rec, httptest.NewRequest(tt.method, "/livekit/webhook", nil))
		if rec.Code != tt.want {
			t.Errorf("%s /livekit/webhook = %d, want %d", tt.method, rec.Code, tt.want)
		}
	}
}
