package main

import (
	"crypto"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
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
)

const (
	testClientID = "dev-client"
	testSecret   = "dev-secret"
	testRedirect = "http://localhost:5173/auth/callback"
	testVerifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
)

var (
	keyOnce sync.Once
	keyErr  error
	testKey *rsa.PrivateKey
)

type testIDP struct {
	t   *testing.T
	p   *provider
	srv *httptest.Server
	ns  atomic.Int64
}

func (idp *testIDP) now() time.Time          { return time.Unix(0, idp.ns.Load()) }
func (idp *testIDP) advance(d time.Duration) { idp.ns.Add(int64(d)) }

// newTestIDP shares one RSA key across tests to keep them fast.
func newTestIDP(t *testing.T) *testIDP {
	t.Helper()
	keyOnce.Do(func() {
		var p *provider
		p, keyErr = newProvider(config{}, slog.New(slog.DiscardHandler))
		if keyErr == nil {
			testKey = p.key
		}
	})
	if keyErr != nil {
		t.Fatal(keyErr)
	}
	idp := &testIDP{t: t}
	idp.ns.Store(time.Now().UnixNano())
	var h http.Handler
	idp.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { h.ServeHTTP(w, r) }))
	t.Cleanup(idp.srv.Close)
	idp.p = &provider{
		cfg: config{
			issuer:       idp.srv.URL,
			clientID:     testClientID,
			clientSecret: testSecret,
			redirectURI:  testRedirect,
		},
		key:   testKey,
		log:   slog.New(slog.DiscardHandler),
		now:   idp.now,
		codes: make(map[string]grant),
	}
	h = idp.p.handler()
	return idp
}

var noRedirect = &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}

func authParams() url.Values {
	return url.Values{
		"client_id":             {testClientID},
		"redirect_uri":          {testRedirect},
		"response_type":         {"code"},
		"scope":                 {"openid email profile"},
		"state":                 {"st-1"},
		"nonce":                 {"n-1"},
		"code_challenge":        {s256(testVerifier)},
		"code_challenge_method": {"S256"},
	}
}

func (idp *testIDP) get(path string) *http.Response {
	idp.t.Helper()
	res, err := noRedirect.Get(idp.srv.URL + path)
	if err != nil {
		idp.t.Fatal(err)
	}
	idp.t.Cleanup(func() { res.Body.Close() })
	return res
}

func (idp *testIDP) postForm(path string, form url.Values) *http.Response {
	idp.t.Helper()
	res, err := noRedirect.PostForm(idp.srv.URL+path, form)
	if err != nil {
		idp.t.Fatal(err)
	}
	idp.t.Cleanup(func() { res.Body.Close() })
	return res
}

// code runs the form POST and returns the code from the redirect.
func (idp *testIDP) code(form url.Values) string {
	idp.t.Helper()
	res := idp.postForm("/authorize", form)
	if res.StatusCode != http.StatusSeeOther {
		idp.t.Fatalf("authorize POST status = %d, want 303", res.StatusCode)
	}
	loc, err := url.Parse(res.Header.Get("Location"))
	if err != nil {
		idp.t.Fatal(err)
	}
	if got := loc.Scheme + "://" + loc.Host + loc.Path; got != testRedirect {
		idp.t.Fatalf("redirected to %q, want %q", got, testRedirect)
	}
	if loc.Query().Get("state") != "st-1" {
		idp.t.Fatalf("state = %q, want st-1", loc.Query().Get("state"))
	}
	c := loc.Query().Get("code")
	if c == "" {
		idp.t.Fatalf("no code in %s", loc)
	}
	return c
}

func withPreset(id string) url.Values {
	f := authParams()
	f.Set("preset", id)
	return f
}

func (idp *testIDP) exchange(id, secret, code, redirect, verifier string) (*http.Response, map[string]any) {
	idp.t.Helper()
	form := url.Values{
		"grant_type":    {"authorization_code"},
		"code":          {code},
		"redirect_uri":  {redirect},
		"code_verifier": {verifier},
	}
	req, err := http.NewRequest(http.MethodPost, idp.srv.URL+"/token", strings.NewReader(form.Encode()))
	if err != nil {
		idp.t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.SetBasicAuth(url.QueryEscape(id), url.QueryEscape(secret))
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		idp.t.Fatal(err)
	}
	defer res.Body.Close()
	var body map[string]any
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		idp.t.Fatal(err)
	}
	return res, body
}

func TestDiscovery(t *testing.T) {
	idp := newTestIDP(t)
	res := idp.get("/.well-known/openid-configuration")
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", res.StatusCode)
	}
	var doc map[string]any
	if err := json.NewDecoder(res.Body).Decode(&doc); err != nil {
		t.Fatal(err)
	}
	for k, want := range map[string]string{
		"issuer":                 idp.srv.URL,
		"authorization_endpoint": idp.srv.URL + "/authorize",
		"token_endpoint":         idp.srv.URL + "/token",
		"jwks_uri":               idp.srv.URL + "/jwks",
	} {
		if doc[k] != want {
			t.Errorf("%s = %v, want %s", k, doc[k], want)
		}
	}

	var set struct {
		Keys []struct{ Kid, Kty, Alg string } `json:"keys"`
	}
	if err := json.NewDecoder(idp.get("/jwks").Body).Decode(&set); err != nil {
		t.Fatal(err)
	}
	if len(set.Keys) != 1 || set.Keys[0].Kid != keyID || set.Keys[0].Kty != "RSA" || set.Keys[0].Alg != "RS256" {
		t.Fatalf("jwks = %+v", set)
	}
}

func TestAuthorizeValidation(t *testing.T) {
	tests := []struct {
		name    string
		mutate  func(url.Values)
		status  int
		errCode string
	}{
		{"valid", func(url.Values) {}, http.StatusOK, ""},
		{"unknown client", func(v url.Values) { v.Set("client_id", "other") }, http.StatusBadRequest, ""},
		{"unregistered redirect", func(v url.Values) { v.Set("redirect_uri", "https://evil.test/cb") }, http.StatusBadRequest, ""},
		{"redirect with extra path", func(v url.Values) { v.Set("redirect_uri", testRedirect+"/x") }, http.StatusBadRequest, ""},
		{"implicit flow", func(v url.Values) { v.Set("response_type", "token") }, http.StatusSeeOther, "unsupported_response_type"},
		{"no openid scope", func(v url.Values) { v.Set("scope", "email") }, http.StatusSeeOther, "invalid_scope"},
		{"plain PKCE", func(v url.Values) { v.Set("code_challenge_method", "plain") }, http.StatusSeeOther, "invalid_request"},
		{"no PKCE", func(v url.Values) { v.Del("code_challenge"); v.Del("code_challenge_method") }, http.StatusSeeOther, "invalid_request"},
		{"malformed challenge", func(v url.Values) { v.Set("code_challenge", "short") }, http.StatusSeeOther, "invalid_request"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			idp := newTestIDP(t)
			v := authParams()
			tt.mutate(v)
			res := idp.get("/authorize?" + v.Encode())
			if res.StatusCode != tt.status {
				t.Fatalf("status = %d, want %d", res.StatusCode, tt.status)
			}
			loc := res.Header.Get("Location")
			if tt.errCode == "" {
				if loc != "" {
					t.Fatalf("redirected to %q", loc)
				}
				return
			}
			u, err := url.Parse(loc)
			if err != nil {
				t.Fatal(err)
			}
			if !strings.HasPrefix(loc, testRedirect+"?") || u.Query().Get("error") != tt.errCode || u.Query().Get("state") != "st-1" {
				t.Fatalf("Location = %q, want error=%s and state", loc, tt.errCode)
			}
		})
	}
}

func TestAuthorizePageEscapes(t *testing.T) {
	idp := newTestIDP(t)
	v := authParams()
	v.Set("state", `"><script>alert(1)</script>`)
	res := idp.get("/authorize?" + v.Encode())
	body, _ := io.ReadAll(res.Body)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", res.StatusCode)
	}
	if strings.Contains(string(body), "<script>alert") {
		t.Fatal("state rendered unescaped")
	}
	if !strings.Contains(res.Header.Get("Content-Security-Policy"), "default-src 'none'") {
		t.Fatal("missing CSP")
	}
	for _, p := range presets {
		if !strings.Contains(string(body), `value="`+p.ID+`"`) {
			t.Errorf("preset %s not rendered", p.ID)
		}
	}
}

func TestAuthorizeDeny(t *testing.T) {
	idp := newTestIDP(t)
	f := authParams()
	f.Set("action", "deny")
	res := idp.postForm("/authorize", f)
	u, _ := url.Parse(res.Header.Get("Location"))
	if res.StatusCode != http.StatusSeeOther || u.Query().Get("error") != "access_denied" || u.Query().Has("code") {
		t.Fatalf("status = %d, Location = %s", res.StatusCode, u)
	}
}

func TestAuthorizePostRevalidates(t *testing.T) {
	idp := newTestIDP(t)
	f := withPreset("ana")
	f.Set("redirect_uri", "https://evil.test/cb")
	if res := idp.postForm("/authorize", f); res.StatusCode != http.StatusBadRequest || res.Header.Get("Location") != "" {
		t.Fatalf("status = %d, Location = %q", res.StatusCode, res.Header.Get("Location"))
	}
}

func TestTokenErrors(t *testing.T) {
	tests := []struct {
		name     string
		id       string
		secret   string
		redirect string
		verifier string
		status   int
		errCode  string
	}{
		{"wrong secret", testClientID, "nope", testRedirect, testVerifier, http.StatusUnauthorized, "invalid_client"},
		{"wrong client", "other", testSecret, testRedirect, testVerifier, http.StatusUnauthorized, "invalid_client"},
		{"wrong verifier", testClientID, testSecret, testRedirect, strings.Repeat("a", 43), http.StatusBadRequest, "invalid_grant"},
		{"short verifier", testClientID, testSecret, testRedirect, "abc", http.StatusBadRequest, "invalid_grant"},
		{"other redirect", testClientID, testSecret, "http://localhost:5173/other", testVerifier, http.StatusBadRequest, "invalid_grant"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			idp := newTestIDP(t)
			code := idp.code(withPreset("ana"))
			res, body := idp.exchange(tt.id, tt.secret, code, tt.redirect, tt.verifier)
			if res.StatusCode != tt.status || body["error"] != tt.errCode {
				t.Fatalf("status = %d, body = %v; want %d %s", res.StatusCode, body, tt.status, tt.errCode)
			}
		})
	}
}

func TestTokenCodeSingleUse(t *testing.T) {
	idp := newTestIDP(t)
	code := idp.code(withPreset("ana"))
	if res, body := idp.exchange(testClientID, testSecret, code, testRedirect, testVerifier); res.StatusCode != http.StatusOK {
		t.Fatalf("first exchange: %d %v", res.StatusCode, body)
	}
	if res, body := idp.exchange(testClientID, testSecret, code, testRedirect, testVerifier); res.StatusCode != http.StatusBadRequest || body["error"] != "invalid_grant" {
		t.Fatalf("reused code: %d %v", res.StatusCode, body)
	}

	// A failed attempt also burns the code.
	code = idp.code(withPreset("ana"))
	idp.exchange(testClientID, testSecret, code, testRedirect, strings.Repeat("a", 43))
	if res, _ := idp.exchange(testClientID, testSecret, code, testRedirect, testVerifier); res.StatusCode != http.StatusBadRequest {
		t.Fatalf("code usable after failed attempt: %d", res.StatusCode)
	}
}

func TestTokenCodeExpires(t *testing.T) {
	idp := newTestIDP(t)
	code := idp.code(withPreset("ana"))
	idp.advance(codeTTL + time.Second)
	if res, body := idp.exchange(testClientID, testSecret, code, testRedirect, testVerifier); res.StatusCode != http.StatusBadRequest || body["error"] != "invalid_grant" {
		t.Fatalf("expired code: %d %v", res.StatusCode, body)
	}
}

func TestIDToken(t *testing.T) {
	idp := newTestIDP(t)
	custom := authParams()
	custom.Set("name", "Zé")
	custom.Set("email", "ze@example.org")
	custom.Set("hd", "")
	// email_verified unchecked: the field is absent.

	tests := []struct {
		name string
		form url.Values
		want idTokenClaims
	}{
		{"preset with hd", withPreset("ana"), idTokenClaims{Email: "ana@example.com", EmailVerified: true, Name: "Ana Souza", HD: "example.com"}},
		{"preset without hd", withPreset("bruno"), idTokenClaims{Email: "bruno@example.com", EmailVerified: true, Name: "Bruno Lima"}},
		{"custom unverified", custom, idTokenClaims{Email: "ze@example.org", Name: "Zé"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			res, body := idp.exchange(testClientID, testSecret, idp.code(tt.form), testRedirect, testVerifier)
			if res.StatusCode != http.StatusOK || body["token_type"] != "Bearer" || body["access_token"] == "" || body["expires_in"] != float64(300) {
				t.Fatalf("token response: %d %v", res.StatusCode, body)
			}
			if res.Header.Get("Cache-Control") != "no-store" {
				t.Error("token response is cacheable")
			}
			raw, _ := body["id_token"].(string)
			claims, raws := verifyJWT(t, idp, raw)

			want := tt.want
			want.Iss = idp.srv.URL
			want.Aud = testClientID
			want.Sub = subject(want.Email)
			want.Nonce = "n-1"
			want.Iat = idp.now().Unix()
			want.Exp = idp.now().Add(idTokenTTL).Unix()
			if claims != want {
				t.Fatalf("claims = %+v\nwant     %+v", claims, want)
			}
			if _, ok := raws["hd"]; ok != (want.HD != "") {
				t.Errorf("hd present = %v, want %v", ok, want.HD != "")
			}
		})
	}
	if subject("Ana@Example.com") != subject("ana@example.com") || subject("ana@example.com") == subject("bruno@example.com") {
		t.Error("subject is not stable per email")
	}
}

// verifyJWT checks the signature against the published JWKS.
func verifyJWT(t *testing.T, idp *testIDP, raw string) (idTokenClaims, map[string]any) {
	t.Helper()
	var set struct {
		Keys []struct{ Kid, N, E string } `json:"keys"`
	}
	if err := json.NewDecoder(idp.get("/jwks").Body).Decode(&set); err != nil {
		t.Fatal(err)
	}
	n, _ := base64.RawURLEncoding.DecodeString(set.Keys[0].N)
	e, _ := base64.RawURLEncoding.DecodeString(set.Keys[0].E)
	pub := &rsa.PublicKey{N: new(big.Int).SetBytes(n), E: int(new(big.Int).SetBytes(e).Int64())}

	parts := strings.Split(raw, ".")
	if len(parts) != 3 {
		t.Fatalf("id_token has %d parts", len(parts))
	}
	var header map[string]string
	decodePart(t, parts[0], &header)
	if header["alg"] != "RS256" || header["kid"] != set.Keys[0].Kid {
		t.Fatalf("header = %v", header)
	}
	sig, _ := base64.RawURLEncoding.DecodeString(parts[2])
	sum := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	if err := rsa.VerifyPKCS1v15(pub, crypto.SHA256, sum[:], sig); err != nil {
		t.Fatalf("signature: %v", err)
	}
	var claims idTokenClaims
	var raws map[string]any
	decodePart(t, parts[1], &claims)
	decodePart(t, parts[1], &raws)
	return claims, raws
}

func decodePart(t *testing.T, s string, v any) {
	t.Helper()
	b, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(b, v); err != nil {
		t.Fatal(err)
	}
}

func TestCheckLoopback(t *testing.T) {
	for addr, ok := range map[string]bool{
		"127.0.0.1:9000":    true,
		"localhost:9000":    true,
		"[::1]:9000":        true,
		"127.0.0.2:9000":    true,
		":9000":             false,
		"0.0.0.0:9000":      false,
		"[::]:9000":         false,
		"192.168.0.10:9000": false,
		"example.com:9000":  false,
		"127.0.0.1":         false,
	} {
		if err := checkLoopback(addr); (err == nil) != ok {
			t.Errorf("checkLoopback(%q) = %v, want ok=%v", addr, err, ok)
		}
	}
}
