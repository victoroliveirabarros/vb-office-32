package httpapi

import (
	"errors"
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

func (fakeOIDC) Login(w http.ResponseWriter, _ *http.Request)    { w.WriteHeader(http.StatusFound) }
func (fakeOIDC) Callback(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusSeeOther) }
func (fakeOIDC) Logout(w http.ResponseWriter, _ *http.Request)   { w.WriteHeader(http.StatusNoContent) }

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
