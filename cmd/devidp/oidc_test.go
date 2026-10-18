package main

import (
	"bytes"
	"html"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"regexp"
	"strings"
	"testing"

	"github.com/victoroliveirabarros/vb-office-32/internal/auth"
)

var hiddenInput = regexp.MustCompile(`<input type="hidden" name="([^"]+)" value="([^"]*)">`)

// TestServerOIDCFlow drives the server's real OIDC login against devidp,
// submitting the form exactly as the page renders it.
func TestServerOIDCFlow(t *testing.T) {
	tests := []struct {
		name   string
		submit url.Values
		status int
		user   *user
	}{
		{"ana", url.Values{"preset": {"ana"}}, http.StatusSeeOther, &presets[0]},
		{"bruno without hd", url.Values{"preset": {"bruno"}}, http.StatusSeeOther, &presets[1]},
		{
			"custom",
			url.Values{"name": {"Zé"}, "email": {"ze@example.com"}, "email_verified": {"true"}, "hd": {"example.com"}},
			http.StatusSeeOther,
			&user{Name: "Zé", Email: "ze@example.com"},
		},
		{"domain not allowed", url.Values{"preset": {"eve"}}, http.StatusForbidden, nil},
		{"email not verified", url.Values{"preset": {"carla"}}, http.StatusForbidden, nil},
		{"hd not allowed", url.Values{"email": {"ze@example.com"}, "email_verified": {"true"}, "hd": {"outsider.test"}}, http.StatusForbidden, nil},
		{"denied at provider", url.Values{"action": {"deny"}}, http.StatusForbidden, nil},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			idp := newTestIDP(t)
			o, err := auth.NewOIDC(auth.OIDCConfig{
				PublicURL:      "http://localhost:5173",
				Issuer:         idp.srv.URL,
				ClientID:       testClientID,
				ClientSecret:   testSecret,
				AllowedDomains: []string{"example.com"},
				SessionKey:     bytes.Repeat([]byte("k"), 32),
				Log:            slog.New(slog.DiscardHandler),
			})
			if err != nil {
				t.Fatal(err)
			}

			rec := httptest.NewRecorder()
			o.Login(rec, httptest.NewRequest(http.MethodGet, "http://localhost:5173/auth/login", nil))
			login := rec.Result()
			authURL := login.Header.Get("Location")
			if login.StatusCode != http.StatusFound || !strings.HasPrefix(authURL, idp.srv.URL+"/authorize?") {
				t.Fatalf("login: %d %q", login.StatusCode, authURL)
			}

			page, err := noRedirect.Get(authURL)
			if err != nil {
				t.Fatal(err)
			}
			body, _ := io.ReadAll(page.Body)
			page.Body.Close()
			if page.StatusCode != http.StatusOK {
				t.Fatalf("authorize page: %d %s", page.StatusCode, body)
			}
			form := url.Values{}
			for _, m := range hiddenInput.FindAllStringSubmatch(string(body), -1) {
				form.Set(m[1], html.UnescapeString(m[2]))
			}
			for k, v := range tt.submit {
				form[k] = v
			}

			back := idp.postForm("/authorize", form)
			callback := back.Header.Get("Location")
			if back.StatusCode != http.StatusSeeOther || !strings.HasPrefix(callback, "http://localhost:5173/auth/callback?") {
				t.Fatalf("authorize POST: %d %q", back.StatusCode, callback)
			}

			req := httptest.NewRequest(http.MethodGet, callback, nil)
			for _, c := range login.Cookies() {
				req.AddCookie(c)
			}
			rec = httptest.NewRecorder()
			o.Callback(rec, req)
			res := rec.Result()
			if res.StatusCode != tt.status {
				t.Fatalf("callback status = %d, want %d", res.StatusCode, tt.status)
			}

			authReq := httptest.NewRequest(http.MethodGet, "http://localhost:5173/api/session", nil)
			for _, c := range res.Cookies() {
				if c.MaxAge >= 0 && c.Value != "" {
					authReq.AddCookie(c)
				}
			}
			id, err := o.Authenticate(authReq)
			if tt.user == nil {
				if err == nil {
					t.Fatalf("refused login has a session: %+v", id)
				}
				return
			}
			if err != nil {
				t.Fatalf("authenticate: %v", err)
			}
			if want := "oidc:" + subject(tt.user.Email); id.ID != want || id.Name != tt.user.Name {
				t.Fatalf("identity = %+v, want id %s name %s", id, want, tt.user.Name)
			}
		})
	}
}
