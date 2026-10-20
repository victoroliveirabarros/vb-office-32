package auth

import (
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"math/big"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/oauth2"
)

const (
	testClientID     = "client-1"
	testClientSecret = "secret-1"
	testSub          = "1234567890"
	testEmail        = "ana@example.com"
)

var testKey = []byte("0123456789abcdef0123456789abcdef")

// clock is shared by the provider and the server under test.
type clock struct{ ns atomic.Int64 }

func newClock() *clock {
	c := &clock{}
	c.ns.Store(time.Date(2026, 1, 2, 9, 0, 0, 0, time.UTC).UnixNano())
	return c
}

func (c *clock) now() time.Time          { return time.Unix(0, c.ns.Load()) }
func (c *clock) advance(d time.Duration) { c.ns.Add(int64(d)) }

// fakeIDP is an OpenID provider with discovery, JWKS, an authorize endpoint
// that redirects straight back and a token endpoint that checks PKCE.
type fakeIDP struct {
	t     *testing.T
	srv   *httptest.Server
	key   *rsa.PrivateKey
	clock *clock

	discoveries atomic.Int32

	mu               sync.Mutex
	failDiscovery    int
	discoveryEntered chan struct{}
	discoveryRelease chan struct{}
	codes            map[string]grant
	claims           func(map[string]any)
	signKID          string
	wrongChallenge   bool
	dropToken        bool
}

type grant struct {
	challenge, nonce, redirect string
}

var (
	rsaOnce sync.Once
	rsaKey  *rsa.PrivateKey
)

func newFakeIDP(t *testing.T, c *clock) *fakeIDP {
	t.Helper()
	rsaOnce.Do(func() {
		var err error
		if rsaKey, err = rsa.GenerateKey(rand.Reader, 2048); err != nil {
			panic(err)
		}
	})
	idp := &fakeIDP{t: t, key: rsaKey, clock: c, codes: map[string]grant{}, signKID: "k1"}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /.well-known/openid-configuration", idp.discovery)
	mux.HandleFunc("GET /jwks", idp.jwks)
	mux.HandleFunc("GET /authorize", idp.authorize)
	mux.HandleFunc("POST /token", idp.token)
	idp.srv = httptest.NewServer(mux)
	t.Cleanup(idp.srv.Close)
	return idp
}

func (idp *fakeIDP) set(f func(*fakeIDP)) {
	idp.mu.Lock()
	defer idp.mu.Unlock()
	f(idp)
}

func (idp *fakeIDP) discovery(w http.ResponseWriter, _ *http.Request) {
	idp.discoveries.Add(1)
	idp.mu.Lock()
	fail := idp.failDiscovery > 0
	if fail {
		idp.failDiscovery--
	}
	entered, release := idp.discoveryEntered, idp.discoveryRelease
	idp.mu.Unlock()
	if release != nil {
		select {
		case entered <- struct{}{}:
		default:
		}
		<-release
	}
	if fail {
		http.Error(w, "unavailable", http.StatusServiceUnavailable)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"issuer":                                idp.srv.URL,
		"authorization_endpoint":                idp.srv.URL + "/authorize",
		"token_endpoint":                        idp.srv.URL + "/token",
		"jwks_uri":                              idp.srv.URL + "/jwks",
		"id_token_signing_alg_values_supported": []string{"RS256"},
	})
}

func (idp *fakeIDP) jwks(w http.ResponseWriter, _ *http.Request) {
	pub := idp.key.PublicKey
	writeJSON(w, http.StatusOK, map[string]any{"keys": []map[string]string{{
		"kty": "RSA",
		"kid": "k1",
		"alg": "RS256",
		"use": "sig",
		"n":   b64(pub.N.Bytes()),
		"e":   b64(big.NewInt(int64(pub.E)).Bytes()),
	}}})
}

func (idp *fakeIDP) authorize(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	if q.Get("response_type") != "code" || q.Get("client_id") != testClientID || q.Get("code_challenge_method") != "S256" {
		http.Error(w, "bad authorize request", http.StatusBadRequest)
		return
	}
	g := grant{challenge: q.Get("code_challenge"), nonce: q.Get("nonce"), redirect: q.Get("redirect_uri")}
	code := rand.Text()
	idp.mu.Lock()
	if idp.wrongChallenge {
		g.challenge = oauth2.S256ChallengeFromVerifier(oauth2.GenerateVerifier())
	}
	idp.codes[code] = g
	idp.mu.Unlock()

	back, err := url.Parse(g.redirect)
	if err != nil {
		http.Error(w, "bad redirect_uri", http.StatusBadRequest)
		return
	}
	back.RawQuery = url.Values{"code": {code}, "state": {q.Get("state")}}.Encode()
	http.Redirect(w, r, back.String(), http.StatusFound)
}

func (idp *fakeIDP) token(w http.ResponseWriter, r *http.Request) {
	idp.mu.Lock()
	drop := idp.dropToken
	idp.mu.Unlock()
	if drop {
		conn, _, err := http.NewResponseController(w).Hijack()
		if err == nil {
			conn.Close()
		}
		return
	}
	id, secret, ok := r.BasicAuth()
	if !ok || id != testClientID || secret != testClientSecret {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "invalid_client"})
		return
	}
	if err := r.ParseForm(); err != nil || r.PostForm.Get("grant_type") != "authorization_code" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_request"})
		return
	}
	code := r.PostForm.Get("code")
	idp.mu.Lock()
	g, found := idp.codes[code]
	delete(idp.codes, code)
	mutate, kid := idp.claims, idp.signKID
	idp.mu.Unlock()
	if !found || g.redirect != r.PostForm.Get("redirect_uri") ||
		oauth2.S256ChallengeFromVerifier(r.PostForm.Get("code_verifier")) != g.challenge {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_grant"})
		return
	}

	now := idp.clock.now()
	claims := map[string]any{
		"iss":            idp.srv.URL,
		"aud":            testClientID,
		"sub":            testSub,
		"email":          testEmail,
		"email_verified": true,
		"name":           "Ana Souza",
		"iat":            now.Unix(),
		"exp":            now.Add(time.Hour).Unix(),
		"nonce":          g.nonce,
	}
	if mutate != nil {
		mutate(claims)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"access_token": "access-token",
		"token_type":   "Bearer",
		"expires_in":   3600,
		"id_token":     idp.sign(kid, claims),
	})
}

func (idp *fakeIDP) sign(kid string, claims map[string]any) string {
	h, err := json.Marshal(map[string]string{"alg": "RS256", "typ": "JWT", "kid": kid})
	if err != nil {
		panic(err)
	}
	p, err := json.Marshal(claims)
	if err != nil {
		panic(err)
	}
	in := b64(h) + "." + b64(p)
	sum := sha256.Sum256([]byte(in))
	sig, err := rsa.SignPKCS1v15(rand.Reader, idp.key, crypto.SHA256, sum[:])
	if err != nil {
		panic(err)
	}
	return in + "." + b64(sig)
}

func b64(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

type harness struct {
	t     *testing.T
	clock *clock
	idp   *fakeIDP
	o     *OIDC
	logs  *syncBuffer
}

type syncBuffer struct {
	mu sync.Mutex
	b  strings.Builder
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuffer) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

func newHarness(t *testing.T, publicURL string) *harness {
	t.Helper()
	c := newClock()
	idp := newFakeIDP(t, c)
	logs := &syncBuffer{}
	o, err := NewOIDC(OIDCConfig{
		PublicURL:      publicURL,
		Issuer:         idp.srv.URL,
		ClientID:       testClientID,
		ClientSecret:   testClientSecret,
		AllowedDomains: []string{"example.com", "example.org"},
		SessionKey:     testKey,
		Log:            slog.New(slog.NewJSONHandler(logs, nil)),
	})
	if err != nil {
		t.Fatal(err)
	}
	o.now = c.now
	return &harness{t: t, clock: c, idp: idp, o: o, logs: logs}
}

// longDomain has 251 bytes, close to the DNS limit.
var longDomain = strings.Repeat(strings.Repeat("d", 60)+".", 4) + "example"

var noRedirect = &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}

// startLogin runs /auth/login and the provider's authorize step, returning
// the callback request the browser would send next.
func (h *harness) startLogin() *http.Request {
	h.t.Helper()
	res := serve(h.o.Login, httptest.NewRequest("GET", "/auth/login", nil))
	if res.StatusCode != http.StatusFound {
		h.t.Fatalf("login status = %d, want 302", res.StatusCode)
	}
	flow := findCookie(res, h.o.flowCookie)
	if flow == nil {
		h.t.Fatal("login set no flow cookie")
	}
	ares, err := noRedirect.Get(res.Header.Get("Location"))
	if err != nil {
		h.t.Fatal(err)
	}
	ares.Body.Close()
	back, err := url.Parse(ares.Header.Get("Location"))
	if ares.StatusCode != http.StatusFound || err != nil {
		h.t.Fatalf("authorize: %d %v", ares.StatusCode, err)
	}
	req := httptest.NewRequest("GET", "/auth/callback?"+back.RawQuery, nil)
	req.AddCookie(flow)
	return req
}

// login completes a successful login and returns the session cookie.
func (h *harness) login() *http.Cookie {
	h.t.Helper()
	res := serve(h.o.Callback, h.startLogin())
	c := findCookie(res, h.o.sessionCookie)
	if res.StatusCode != http.StatusSeeOther || c == nil {
		h.t.Fatalf("callback = %d, session cookie %v", res.StatusCode, c)
	}
	return c
}

func (h *harness) authenticate(c *http.Cookie) (Identity, error) {
	req := httptest.NewRequest("GET", "/ws?name=Mallory", nil)
	if c != nil {
		req.AddCookie(c)
	}
	return h.o.Authenticate(req)
}

func serve(h http.HandlerFunc, req *http.Request) *http.Response {
	rec := httptest.NewRecorder()
	h(rec, req)
	return rec.Result()
}

func findCookie(res *http.Response, name string) *http.Cookie {
	for _, c := range res.Cookies() {
		if c.Name == name {
			return c
		}
	}
	return nil
}

func TestLoginSuccess(t *testing.T) {
	tests := []struct {
		publicURL, cookie, flowCookie string
		secure                        bool
	}{
		{"http://localhost:5173", "vb_office32_session", "vb_office32_oidc", false},
		{"https://office.example", "__Host-vb_office32_session", "__Host-vb_office32_oidc", true},
	}
	for _, tt := range tests {
		t.Run(tt.publicURL, func(t *testing.T) {
			h := newHarness(t, tt.publicURL)

			res := serve(h.o.Login, httptest.NewRequest("GET", "/auth/login", nil))
			if got := res.Header.Get("Cache-Control"); got != "no-store" {
				t.Errorf("login Cache-Control = %q", got)
			}
			flow := findCookie(res, tt.flowCookie)
			if flow == nil || !flow.HttpOnly || flow.SameSite != http.SameSiteLaxMode || flow.Path != "/" ||
				flow.MaxAge != 600 || flow.Secure != tt.secure {
				t.Errorf("flow cookie = %+v", flow)
			}
			loc, err := url.Parse(res.Header.Get("Location"))
			if err != nil {
				t.Fatal(err)
			}
			q := loc.Query()
			if !strings.HasPrefix(loc.String(), h.idp.srv.URL+"/authorize?") ||
				q.Get("redirect_uri") != tt.publicURL+"/auth/callback" ||
				q.Get("scope") != "openid email profile" ||
				q.Get("code_challenge_method") != "S256" || q.Get("code_challenge") == "" ||
				q.Get("state") == "" || q.Get("nonce") == "" || q.Has("hd") {
				t.Errorf("authorize URL = %s", loc)
			}

			res = serve(h.o.Callback, h.startLogin())
			if res.StatusCode != http.StatusSeeOther || res.Header.Get("Location") != "/" {
				t.Fatalf("callback = %d %q, want 303 /", res.StatusCode, res.Header.Get("Location"))
			}
			if res.Header.Get("Cache-Control") != "no-store" || res.Header.Get("Referrer-Policy") != "no-referrer" {
				t.Errorf("callback headers = %v", res.Header)
			}
			if c := findCookie(res, tt.flowCookie); c == nil || c.MaxAge >= 0 || c.Path != "/" {
				t.Errorf("flow cookie not deleted: %+v", c)
			}
			sess := findCookie(res, tt.cookie)
			if sess == nil || !sess.HttpOnly || sess.SameSite != http.SameSiteLaxMode || sess.Path != "/" ||
				sess.MaxAge != 12*3600 || sess.Secure != tt.secure || sess.Domain != "" {
				t.Fatalf("session cookie = %+v", sess)
			}

			id, err := h.authenticate(sess)
			if err != nil {
				t.Fatal(err)
			}
			want := Identity{ID: "oidc:" + testSub, Name: "Ana Souza", Expires: h.clock.now().Add(12 * time.Hour).Truncate(time.Second)}
			if !id.Expires.Equal(want.Expires) || id.ID != want.ID || id.Name != want.Name {
				t.Errorf("identity = %+v, want %+v", id, want)
			}
		})
	}
}

func TestGoogleHDHint(t *testing.T) {
	h := newHarness(t, "http://localhost:5173")
	h.o.requireHD = true
	h.o.domains = []string{"example.com"}
	res := serve(h.o.Login, httptest.NewRequest("GET", "/auth/login", nil))
	loc, err := url.Parse(res.Header.Get("Location"))
	if err != nil || loc.Query().Get("hd") != "example.com" {
		t.Errorf("authorize URL = %v, want hd=example.com", loc)
	}
}

func TestCallbackRejects(t *testing.T) {
	claims := func(f func(map[string]any)) func(*fakeIDP) {
		return func(idp *fakeIDP) { idp.claims = f }
	}
	tests := []struct {
		name   string
		idp    func(*fakeIDP)
		before func(*harness, *http.Request)
		status int
		reason string
	}{
		{name: "state mismatch", reason: "invalid login flow", status: 400, before: func(_ *harness, r *http.Request) {
			q := r.URL.Query()
			q.Set("state", rand.Text())
			r.URL.RawQuery = q.Encode()
		}},
		{name: "flow cookie missing", reason: "invalid login flow", status: 400, before: func(_ *harness, r *http.Request) {
			r.Header.Del("Cookie")
		}},
		{name: "flow cookie expired", reason: "invalid login flow", status: 400, before: func(h *harness, _ *http.Request) {
			h.clock.advance(flowTTL + time.Second)
		}},
		{name: "flow cookie signed with session key", reason: "invalid login flow", status: 400, before: func(h *harness, r *http.Request) {
			c, err := r.Cookie(h.o.flowCookie)
			if err != nil {
				h.t.Fatal(err)
			}
			var f flowPayload
			if err := h.o.flow.open(c.Value, h.clock.now(), &f); err != nil {
				h.t.Fatal(err)
			}
			token, err := h.o.session.seal(&f)
			if err != nil {
				h.t.Fatal(err)
			}
			r.Header.Del("Cookie")
			r.AddCookie(&http.Cookie{Name: h.o.flowCookie, Value: token})
		}},
		// A sibling subdomain can plant an unprefixed cookie but not a
		// __Host- one, so only the prefixed name may carry the flow.
		{name: "flow cookie without host prefix", reason: "invalid login flow", status: 400, before: func(h *harness, r *http.Request) {
			c, err := r.Cookie(h.o.flowCookie)
			if err != nil {
				h.t.Fatal(err)
			}
			r.Header.Del("Cookie")
			r.AddCookie(&http.Cookie{Name: flowCookie, Value: c.Value})
		}},
		{name: "session too large", reason: "token exceeds size limit", status: 500,
			idp: claims(func(c map[string]any) {
				c["sub"] = strings.Repeat("<", 255)
				c["name"] = strings.Repeat("<", maxNameRunes)
				c["email"] = "a@" + longDomain
				c["hd"] = longDomain
			}),
			before: func(h *harness, _ *http.Request) { h.o.domains = append(h.o.domains, longDomain) },
		},
		{name: "provider error", reason: "provider returned no code", status: 403, before: func(_ *harness, r *http.Request) {
			r.URL.RawQuery = url.Values{
				"state":             {r.URL.Query().Get("state")},
				"error":             {"access_denied"},
				"error_description": {"<script>alert(1)</script>"},
			}.Encode()
		}},
		{name: "nonce mismatch", reason: "nonce mismatch", status: 403, idp: claims(func(c map[string]any) { c["nonce"] = "other" })},
		{name: "nonce missing", reason: "nonce mismatch", status: 403, idp: claims(func(c map[string]any) { delete(c, "nonce") })},
		{name: "wrong audience", reason: "expected audience", status: 403, idp: claims(func(c map[string]any) { c["aud"] = "other-client" })},
		{name: "wrong issuer", reason: "different provider", status: 403, idp: claims(func(c map[string]any) { c["iss"] = "https://evil.example" })},
		{name: "expired id token", reason: "token is expired", status: 403, idp: claims(func(c map[string]any) {
			c["exp"] = c["iat"].(int64) - 60
		})},
		{name: "unknown kid", reason: "failed to verify signature", status: 403, idp: func(idp *fakeIDP) { idp.signKID = "k2" }},
		{name: "wrong PKCE verifier", reason: "invalid_grant", status: 403, idp: func(idp *fakeIDP) { idp.wrongChallenge = true }},
		{name: "email not verified", reason: "email not verified", status: 403, idp: claims(func(c map[string]any) { c["email_verified"] = false })},
		{name: "email_verified string false", reason: "email not verified", status: 403, idp: claims(func(c map[string]any) { c["email_verified"] = "false" })},
		{name: "email_verified missing", reason: "email not verified", status: 403, idp: claims(func(c map[string]any) { delete(c, "email_verified") })},
		{name: "domain not allowed", reason: "email domain not allowed", status: 403, idp: claims(func(c map[string]any) { c["email"] = "ana@evil.example" })},
		{name: "lookalike domain", reason: "email domain not allowed", status: 403, idp: claims(func(c map[string]any) { c["email"] = "ana@example.com.evil.example" })},
		{name: "hd not allowed", reason: "hd domain not allowed", status: 403, idp: claims(func(c map[string]any) { c["hd"] = "evil.example" })},
		{name: "empty subject", reason: "invalid subject", status: 403, idp: claims(func(c map[string]any) { c["sub"] = "" })},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := newHarness(t, "https://office.example")
			if tt.idp != nil {
				h.idp.set(tt.idp)
			}
			req := h.startLogin()
			code := req.URL.Query().Get("code")
			if tt.before != nil {
				tt.before(h, req)
			}
			res := serve(h.o.Callback, req)
			body := readBody(t, res)

			if res.StatusCode != tt.status {
				t.Errorf("status = %d, want %d (%s)", res.StatusCode, tt.status, body)
			}
			if c := findCookie(res, h.o.sessionCookie); c != nil {
				t.Errorf("session cookie set: %+v", c)
			}
			if c := findCookie(res, h.o.flowCookie); c == nil || c.MaxAge >= 0 {
				t.Errorf("flow cookie not deleted: %+v", c)
			}
			if res.Header.Get("Cache-Control") != "no-store" || res.Header.Get("Referrer-Policy") != "no-referrer" {
				t.Errorf("headers = %v", res.Header)
			}
			for _, leak := range []string{code, testEmail, "access_denied", "script", "evil"} {
				if leak != "" && strings.Contains(body, leak) {
					t.Errorf("body echoes %q: %s", leak, body)
				}
			}
			logs := h.logs.String()
			if !strings.Contains(logs, tt.reason) {
				t.Errorf("logs do not mention %q: %s", tt.reason, logs)
			}
			for _, leak := range []string{code, testEmail, "access-token", "ey"} {
				if leak != "" && strings.Contains(logs, leak) {
					t.Errorf("logs contain %q: %s", leak, logs)
				}
			}
		})
	}
}

func TestEmailVerifiedString(t *testing.T) {
	h := newHarness(t, "http://localhost:5173")
	h.idp.set(func(idp *fakeIDP) {
		idp.claims = func(c map[string]any) { c["email_verified"] = "true" }
	})
	if _, err := h.authenticate(h.login()); err != nil {
		t.Fatal(err)
	}
}

func TestLoginSanitizesName(t *testing.T) {
	h := newHarness(t, "http://localhost:5173")
	h.idp.set(func(idp *fakeIDP) {
		idp.claims = func(c map[string]any) { c["name"] = " José\u202e\u0007 Ávila " }
	})
	id, err := h.authenticate(h.login())
	if err != nil {
		t.Fatal(err)
	}
	if id.Name != "José Ávila" {
		t.Errorf("name = %q, want %q", id.Name, "José Ávila")
	}
}

func TestCodeIsSingleUse(t *testing.T) {
	h := newHarness(t, "http://localhost:5173")
	req := h.startLogin()
	replay := req.Clone(req.Context())
	if res := serve(h.o.Callback, req); res.StatusCode != http.StatusSeeOther {
		t.Fatalf("first callback = %d", res.StatusCode)
	}
	if res := serve(h.o.Callback, replay); res.StatusCode != http.StatusForbidden {
		t.Errorf("replayed callback = %d, want 403", res.StatusCode)
	}
}

func TestCallbackProviderUnavailable(t *testing.T) {
	t.Run("token endpoint down", func(t *testing.T) {
		h := newHarness(t, "http://localhost:5173")
		req := h.startLogin()
		h.idp.set(func(idp *fakeIDP) { idp.dropToken = true })
		res := serve(h.o.Callback, req)
		if res.StatusCode != http.StatusBadGateway || findCookie(res, h.o.sessionCookie) != nil {
			t.Errorf("callback = %d, cookies %v, want 502 without session", res.StatusCode, res.Cookies())
		}
	})
	t.Run("discovery down after restart", func(t *testing.T) {
		h := newHarness(t, "http://localhost:5173")
		req := h.startLogin()
		restarted, err := NewOIDC(OIDCConfig{
			PublicURL:      "http://localhost:5173",
			Issuer:         h.idp.srv.URL,
			ClientID:       testClientID,
			ClientSecret:   testClientSecret,
			AllowedDomains: []string{"example.com"},
			SessionKey:     testKey,
			Log:            slog.New(slog.DiscardHandler),
		})
		if err != nil {
			t.Fatal(err)
		}
		restarted.now = h.clock.now
		h.idp.set(func(idp *fakeIDP) { idp.failDiscovery = 1 })
		if res := serve(restarted.Callback, req); res.StatusCode != http.StatusServiceUnavailable {
			t.Errorf("callback = %d, want 503", res.StatusCode)
		}
	})
}

func TestDiscoveryIsLazyAndRetried(t *testing.T) {
	h := newHarness(t, "http://localhost:5173")
	if n := h.idp.discoveries.Load(); n != 0 {
		t.Fatalf("NewOIDC made %d discovery requests, want 0", n)
	}
	h.idp.set(func(idp *fakeIDP) { idp.failDiscovery = 1 })

	res := serve(h.o.Login, httptest.NewRequest("GET", "/auth/login", nil))
	if res.StatusCode != http.StatusServiceUnavailable || findCookie(res, h.o.flowCookie) != nil {
		t.Errorf("login during outage = %d, cookies %v", res.StatusCode, res.Cookies())
	}
	for range 2 {
		if res := serve(h.o.Login, httptest.NewRequest("GET", "/auth/login", nil)); res.StatusCode != http.StatusFound {
			t.Errorf("login after outage = %d, want 302", res.StatusCode)
		}
	}
	if n := h.idp.discoveries.Load(); n != 2 {
		t.Errorf("discovery requests = %d, want 2 (one failed, one cached)", n)
	}
}

func TestDiscoveryInProgressFailsFast(t *testing.T) {
	h := newHarness(t, "http://localhost:5173")
	entered, release := make(chan struct{}, 1), make(chan struct{})
	unblock := sync.OnceFunc(func() { close(release) })
	defer unblock()
	h.idp.set(func(idp *fakeIDP) { idp.discoveryEntered, idp.discoveryRelease = entered, release })

	login := func(out chan<- int) {
		out <- serve(h.o.Login, httptest.NewRequest("GET", "/auth/login", nil)).StatusCode
	}
	first, second := make(chan int, 1), make(chan int, 1)
	go login(first)
	<-entered
	go login(second)
	select {
	case code := <-second:
		if code != http.StatusServiceUnavailable {
			t.Errorf("login during discovery = %d, want 503", code)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("login queued behind a running discovery")
	}

	unblock()
	if code := <-first; code != http.StatusFound {
		t.Errorf("first login = %d, want 302", code)
	}
	if res := serve(h.o.Login, httptest.NewRequest("GET", "/auth/login", nil)); res.StatusCode != http.StatusFound {
		t.Errorf("login after discovery = %d, want 302", res.StatusCode)
	}
	if n := h.idp.discoveries.Load(); n != 1 {
		t.Errorf("discovery requests = %d, want 1", n)
	}
}

func TestSessionCookie(t *testing.T) {
	h := newHarness(t, "https://office.example")
	sess := h.login()

	tamper := func(f func(body, sig string) string) *http.Cookie {
		body, sig, _ := strings.Cut(sess.Value, ".")
		return &http.Cookie{Name: sess.Name, Value: f(body, sig)}
	}
	flipped := func(s string) string {
		b := []byte(s)
		b[len(b)/2] ^= 1
		return string(b)
	}
	sealed := func(p sessionPayload) *http.Cookie {
		token, err := h.o.session.seal(&p)
		if err != nil {
			t.Fatal(err)
		}
		return &http.Cookie{Name: sess.Name, Value: token}
	}
	exp := h.clock.now().Add(time.Hour)
	forged := func() *http.Cookie {
		raw, _ := base64.RawURLEncoding.DecodeString(strings.Split(sess.Value, ".")[0])
		var p sessionPayload
		if err := json.Unmarshal(raw, &p); err != nil {
			t.Fatal(err)
		}
		p.Sub = "admin"
		b, _ := json.Marshal(p)
		return tamper(func(_, sig string) string { return b64(b) + "." + sig })
	}

	tests := []struct {
		name   string
		cookie *http.Cookie
	}{
		{"no cookie", nil},
		{"tampered payload", tamper(func(body, sig string) string { return flipped(body) + "." + sig })},
		{"tampered signature", tamper(func(body, sig string) string { return body + "." + flipped(sig) })},
		{"forged subject", forged()},
		{"no signature", tamper(func(body, _ string) string { return body })},
		{"oversized", tamper(func(body, sig string) string { return strings.Repeat("A", maxTokenLen) + body + "." + sig })},
		{"unprefixed name", &http.Cookie{Name: sessionCookie, Value: sess.Value}},
		{"version 1", sealed(sessionPayload{header: header{V: 1, Exp: exp.Unix()}, Sub: testSub, Name: "Ana", Domain: "example.com", HD: "example.com"})},
		{"no domain", sealed(sessionPayload{header: newHeader(exp), Sub: testSub, Name: "Ana", HD: "example.com"})},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if _, err := h.authenticate(tt.cookie); !errors.Is(err, ErrNoSession) {
				t.Errorf("err = %v, want ErrNoSession", err)
			}
		})
	}

	t.Run("flow cookie as session", func(t *testing.T) {
		res := serve(h.o.Login, httptest.NewRequest("GET", "/auth/login", nil))
		flow := findCookie(res, h.o.flowCookie)
		if _, err := h.authenticate(&http.Cookie{Name: sess.Name, Value: flow.Value}); !errors.Is(err, ErrNoSession) {
			t.Errorf("err = %v, want ErrNoSession", err)
		}
	})

	t.Run("other key", func(t *testing.T) {
		other, err := NewOIDC(OIDCConfig{
			PublicURL:      "https://office.example",
			AllowedDomains: []string{"example.com"},
			SessionKey:     []byte(strings.Repeat("k", 32)),
		})
		if err != nil {
			t.Fatal(err)
		}
		req := httptest.NewRequest("GET", "/ws", nil)
		req.AddCookie(sess)
		if _, err := other.Authenticate(req); !errors.Is(err, ErrNoSession) {
			t.Errorf("err = %v, want ErrNoSession", err)
		}
	})

	t.Run("domain removed after login", func(t *testing.T) {
		narrowed, err := NewOIDC(OIDCConfig{
			PublicURL:      "https://office.example",
			AllowedDomains: []string{"example.org"},
			SessionKey:     testKey,
		})
		if err != nil {
			t.Fatal(err)
		}
		req := httptest.NewRequest("GET", "/ws", nil)
		req.AddCookie(sess)
		if _, err := narrowed.Authenticate(req); !errors.Is(err, ErrNoSession) {
			t.Errorf("err = %v, want ErrNoSession", err)
		}
	})

	t.Run("still valid before expiry", func(t *testing.T) {
		h.clock.advance(sessionTTL - time.Second)
		if _, err := h.authenticate(sess); err != nil {
			t.Errorf("err = %v", err)
		}
	})

	t.Run("expired", func(t *testing.T) {
		h.clock.advance(time.Second)
		if _, err := h.authenticate(sess); !errors.Is(err, ErrNoSession) {
			t.Errorf("err = %v, want ErrNoSession", err)
		}
	})
}

func TestSessionPayloadHasNoEmail(t *testing.T) {
	h := newHarness(t, "https://office.example")
	h.idp.set(func(idp *fakeIDP) {
		idp.claims = func(c map[string]any) {
			c["name"] = ""
			c["email"] = "Ana.Lima@Example.COM"
			c["hd"] = "example.com"
		}
	})
	sess := h.login()
	body, _, _ := strings.Cut(sess.Value, ".")
	raw, err := base64.RawURLEncoding.DecodeString(body)
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatal(err)
	}
	keys, err := deskKeys(testKey)
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]any{
		"v": float64(2), "exp": got["exp"], "sub": testSub, "name": "Ana.Lima", "domain": "example.com", "hd": "example.com",
		"et": deskTag(keys[0], "ana.lima@example.com"),
	}
	if len(got) != len(want) || strings.Contains(string(raw), "@") {
		t.Errorf("payload = %s, want only %v", raw, want)
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("payload[%q] = %v, want %v", k, got[k], v)
		}
	}
	id, err := h.authenticate(sess)
	if err != nil || id.Name != "Ana.Lima" {
		t.Errorf("identity = %+v, %v", id, err)
	}
}

func TestLogout(t *testing.T) {
	h := newHarness(t, "https://office.example")
	res := serve(h.o.Logout, httptest.NewRequest("POST", "/auth/logout", nil))
	if res.StatusCode != http.StatusNoContent || res.Header.Get("Cache-Control") != "no-store" {
		t.Errorf("logout = %d %v", res.StatusCode, res.Header)
	}
	c := findCookie(res, "__Host-vb_office32_session")
	if c == nil || c.MaxAge >= 0 || c.Value != "" || c.Path != "/" || !c.Secure {
		t.Errorf("session cookie not cleared: %+v", c)
	}
}

func TestAuthorize(t *testing.T) {
	allowed := []string{"example.com", "example.org", "kempresa.com"}
	ok := idClaims{Sub: testSub, Email: testEmail, EmailVerified: true, HD: "example.com"}
	with := func(f func(*idClaims)) idClaims {
		c := ok
		f(&c)
		return c
	}
	tests := []struct {
		name      string
		claims    idClaims
		requireHD bool
		want      error
	}{
		{"workspace account", ok, true, nil},
		{"hd missing with Google", with(func(c *idClaims) { c.HD = "" }), true, errHDMissing},
		{"hd missing elsewhere", with(func(c *idClaims) { c.HD = "" }), false, nil},
		{"hd not allowed", with(func(c *idClaims) { c.HD = "evil.example" }), false, errHDDomain},
		{"hd in other allowed domain", with(func(c *idClaims) { c.HD = "EXAMPLE.ORG" }), true, nil},
		{"mixed case email", with(func(c *idClaims) { c.Email = "Ana@Example.COM" }), true, nil},
		{"last at sign wins", with(func(c *idClaims) { c.Email = `"a@evil.example"@example.com` }), true, nil},
		{"domain not allowed", with(func(c *idClaims) { c.Email = "ana@evil.example" }), true, errEmailDomain},
		{"subdomain", with(func(c *idClaims) { c.Email = "ana@mail.example.com" }), true, errEmailDomain},
		{"no email", with(func(c *idClaims) { c.Email = "" }), true, errEmailDomain},
		{"no local part", with(func(c *idClaims) { c.Email = "@example.com" }), true, errEmailDomain},
		{"email too long", with(func(c *idClaims) { c.Email = strings.Repeat("a", 250) + "@example.com" }), true, errEmailDomain},
		{"ascii uppercase K", with(func(c *idClaims) { c.Email, c.HD = "a@Kempresa.com", "Kempresa.com" }), true, nil},
		{"kelvin sign in email", with(func(c *idClaims) { c.Email, c.HD = "a@\u212Aempresa.com", "kempresa.com" }), true, errEmailDomain},
		{"kelvin sign in hd", with(func(c *idClaims) { c.Email, c.HD = "a@kempresa.com", "\u212Aempresa.com" }), true, errHDDomain},
		{"non-ascii local part", with(func(c *idClaims) { c.Email = "jos\u00e9@example.com" }), true, errEmailDomain},
		{"not verified", with(func(c *idClaims) { c.EmailVerified = false }), true, errEmailNotVerified},
		{"no subject", with(func(c *idClaims) { c.Sub = "" }), true, errSubject},
		{"subject with space", with(func(c *idClaims) { c.Sub = "a b" }), true, errSubject},
		{"subject too long", with(func(c *idClaims) { c.Sub = strings.Repeat("1", 256) }), true, errSubject},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if err := authorize(tt.claims, allowed, tt.requireHD); !errors.Is(err, tt.want) {
				t.Errorf("authorize = %v, want %v", err, tt.want)
			}
		})
	}
}

func TestFlexBool(t *testing.T) {
	tests := map[string]bool{
		`true`: true, `"true"`: true,
		`false`: false, `"false"`: false, `"TRUE"`: false, `1`: false, `null`: false, `"yes"`: false,
	}
	for in, want := range tests {
		var c idClaims
		if err := json.Unmarshal([]byte(`{"email_verified":`+in+`}`), &c); err != nil {
			t.Fatalf("%s: %v", in, err)
		}
		if bool(c.EmailVerified) != want {
			t.Errorf("%s = %v, want %v", in, c.EmailVerified, want)
		}
	}
}

func TestDisplayName(t *testing.T) {
	tests := []struct {
		name, email, want string
	}{
		{"Ana Souza", testEmail, "Ana Souza"},
		{"  João Ninguém  ", testEmail, "João Ninguém"},
		{"\u202eanA\u200b", testEmail, "anA"},
		{"a\x00b\nc\td", testEmail, "abcd"},
		{"bad\xffutf8", testEmail, "badutf8"},
		{strings.Repeat("é", 40), testEmail, strings.Repeat("é", 32)},
		{strings.Repeat("a", 31) + " b", testEmail, strings.Repeat("a", 31)},
		{"", "maria.silva@example.com", "maria.silva"},
		{" \u200e ", "maria.silva@example.com", "maria.silva"},
		{"", "", "user"},
	}
	for _, tt := range tests {
		if got := displayName(tt.name, tt.email); got != tt.want {
			t.Errorf("displayName(%q, %q) = %q, want %q", tt.name, tt.email, got, tt.want)
		}
	}
}

func TestNewOIDCRejectsShortKey(t *testing.T) {
	if _, err := NewOIDC(OIDCConfig{AllowedDomains: []string{"example.com"}, SessionKey: make([]byte, 31)}); err == nil {
		t.Error("NewOIDC accepted a 31-byte key")
	}
	if _, err := NewOIDC(OIDCConfig{SessionKey: testKey}); err == nil {
		t.Error("NewOIDC accepted no allowed domains")
	}
}

func readBody(t *testing.T, res *http.Response) string {
	t.Helper()
	b, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}
