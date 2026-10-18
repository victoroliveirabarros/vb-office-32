package main

import (
	"bytes"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/subtle"
	"embed"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"html/template"
	"log/slog"
	"maps"
	"math/big"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"sync"
	"time"
)

const (
	keyID        = "devidp-1"
	codeTTL      = 60 * time.Second
	idTokenTTL   = 5 * time.Minute
	maxFormBytes = 16 << 10
)

//go:embed authorize.html
var templates embed.FS

var authorizePage = template.Must(template.ParseFS(templates, "authorize.html"))

type config struct {
	issuer       string
	clientID     string
	clientSecret string
	redirectURI  string
}

type user struct {
	ID            string
	Name          string
	Email         string
	EmailVerified bool
	HD            string
	Note          string
}

// presets cover the accepted and refused cases with ALLOWED_DOMAINS=example.com.
var presets = []user{
	{ID: "ana", Name: "Ana Souza", Email: "ana@example.com", EmailVerified: true, HD: "example.com", Note: "aceito: domínio permitido, com hd"},
	{ID: "bruno", Name: "Bruno Lima", Email: "bruno@example.com", EmailVerified: true, Note: "aceito: domínio permitido, sem hd"},
	{ID: "eve", Name: "Eve", Email: "eve@outsider.test", EmailVerified: true, HD: "outsider.test", Note: "recusado: domínio fora da lista"},
	{ID: "carla", Name: "Carla Dias", Email: "carla@example.com", EmailVerified: false, HD: "example.com", Note: "recusado: email não verificado"},
}

type grant struct {
	clientID    string
	redirectURI string
	challenge   string
	nonce       string
	user        user
	expires     time.Time
}

type provider struct {
	cfg config
	key *rsa.PrivateKey
	log *slog.Logger
	now func() time.Time

	mu    sync.Mutex
	codes map[string]grant
}

func newProvider(cfg config, log *slog.Logger) (*provider, error) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return nil, err
	}
	return &provider{cfg: cfg, key: key, log: log, now: time.Now, codes: make(map[string]grant)}, nil
}

func (p *provider) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /.well-known/openid-configuration", p.discovery)
	mux.HandleFunc("GET /jwks", p.jwks)
	mux.HandleFunc("GET /authorize", p.authorizeForm)
	mux.HandleFunc("POST /authorize", p.authorizeSubmit)
	mux.HandleFunc("POST /token", p.token)
	return mux
}

func (p *provider) endpoint(path string) string {
	return strings.TrimSuffix(p.cfg.issuer, "/") + path
}

func (p *provider) discovery(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"issuer":                                p.cfg.issuer,
		"authorization_endpoint":                p.endpoint("/authorize"),
		"token_endpoint":                        p.endpoint("/token"),
		"jwks_uri":                              p.endpoint("/jwks"),
		"response_types_supported":              []string{"code"},
		"grant_types_supported":                 []string{"authorization_code"},
		"subject_types_supported":               []string{"public"},
		"id_token_signing_alg_values_supported": []string{"RS256"},
		"scopes_supported":                      []string{"openid", "email", "profile"},
		"token_endpoint_auth_methods_supported": []string{"client_secret_basic"},
		"code_challenge_methods_supported":      []string{"S256"},
		"claims_supported":                      []string{"iss", "sub", "aud", "exp", "iat", "nonce", "email", "email_verified", "name", "hd"},
	})
}

func (p *provider) jwks(w http.ResponseWriter, _ *http.Request) {
	pub := p.key.PublicKey
	writeJSON(w, http.StatusOK, map[string]any{"keys": []map[string]string{{
		"kty": "RSA",
		"use": "sig",
		"alg": "RS256",
		"kid": keyID,
		"n":   b64(pub.N.Bytes()),
		"e":   b64(big.NewInt(int64(pub.E)).Bytes()),
	}}})
}

type authRequest struct {
	ClientID     string
	RedirectURI  string
	ResponseType string
	Scope        string
	State        string
	Nonce        string
	Challenge    string
	Method       string
}

func parseAuthRequest(v url.Values) authRequest {
	return authRequest{
		ClientID:     v.Get("client_id"),
		RedirectURI:  v.Get("redirect_uri"),
		ResponseType: v.Get("response_type"),
		Scope:        v.Get("scope"),
		State:        v.Get("state"),
		Nonce:        v.Get("nonce"),
		Challenge:    v.Get("code_challenge"),
		Method:       v.Get("code_challenge_method"),
	}
}

// hidden carries the request through the form so the POST is stateless.
func (a authRequest) hidden() [][2]string {
	return [][2]string{
		{"client_id", a.ClientID},
		{"redirect_uri", a.RedirectURI},
		{"response_type", a.ResponseType},
		{"scope", a.Scope},
		{"state", a.State},
		{"nonce", a.Nonce},
		{"code_challenge", a.Challenge},
		{"code_challenge_method", a.Method},
	}
}

// redirectError is reported to the client through redirect_uri; any other
// error means the redirect URI cannot be trusted and is shown on the page.
type redirectError struct {
	code string
	desc string
}

func (e *redirectError) Error() string { return e.code + ": " + e.desc }

func (p *provider) check(a authRequest) error {
	switch {
	case a.ClientID != p.cfg.clientID:
		return errors.New("client_id desconhecido")
	case a.RedirectURI != p.cfg.redirectURI:
		return errors.New("redirect_uri não registrado (esperado " + p.cfg.redirectURI + ")")
	case a.ResponseType != "code":
		return &redirectError{"unsupported_response_type", "response_type must be code"}
	case !slices.Contains(strings.Fields(a.Scope), "openid"):
		return &redirectError{"invalid_scope", "scope must include openid"}
	case a.Method != "S256":
		return &redirectError{"invalid_request", "code_challenge_method must be S256"}
	case !validChallenge(a.Challenge):
		return &redirectError{"invalid_request", "code_challenge must be a base64url SHA-256"}
	}
	return nil
}

func (p *provider) authorizeForm(w http.ResponseWriter, r *http.Request) {
	a := parseAuthRequest(r.URL.Query())
	if !p.checked(w, r, a) {
		return
	}
	writeHTML(w, http.StatusOK, map[string]any{
		"Hidden":      a.hidden(),
		"Presets":     presets,
		"Default":     presets[0],
		"ClientID":    a.ClientID,
		"RedirectURI": a.RedirectURI,
	})
}

func (p *provider) authorizeSubmit(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxFormBytes)
	if err := r.ParseForm(); err != nil {
		writeError(w, http.StatusBadRequest, "formulário inválido")
		return
	}
	f := r.PostForm
	a := parseAuthRequest(f)
	if !p.checked(w, r, a) {
		return
	}
	if f.Get("action") == "deny" {
		p.redirect(w, r, a, url.Values{"error": {"access_denied"}})
		return
	}
	u, ok := formUser(f)
	if !ok {
		writeError(w, http.StatusBadRequest, "usuário inválido: informe um email ou escolha um usuário pré-definido")
		return
	}

	code := rand.Text()
	now := p.now()
	p.mu.Lock()
	maps.DeleteFunc(p.codes, func(_ string, g grant) bool { return now.After(g.expires) })
	p.codes[code] = grant{
		clientID:    a.ClientID,
		redirectURI: a.RedirectURI,
		challenge:   a.Challenge,
		nonce:       a.Nonce,
		user:        u,
		expires:     now.Add(codeTTL),
	}
	p.mu.Unlock()
	p.log.Info("code issued", "email", u.Email, "email_verified", u.EmailVerified, "hd", u.HD)
	p.redirect(w, r, a, url.Values{"code": {code}})
}

// checked writes the error response and reports false when a is invalid.
func (p *provider) checked(w http.ResponseWriter, r *http.Request, a authRequest) bool {
	err := p.check(a)
	if err == nil {
		return true
	}
	p.log.Info("authorize rejected", "err", err)
	if re, ok := errors.AsType[*redirectError](err); ok {
		p.redirect(w, r, a, url.Values{"error": {re.code}, "error_description": {re.desc}})
		return false
	}
	writeError(w, http.StatusBadRequest, err.Error())
	return false
}

// redirect must only be called after check accepted a.RedirectURI.
func (p *provider) redirect(w http.ResponseWriter, r *http.Request, a authRequest, params url.Values) {
	u, err := url.Parse(a.RedirectURI)
	if err != nil {
		writeError(w, http.StatusBadRequest, "redirect_uri inválido")
		return
	}
	q := u.Query()
	for k, v := range params {
		q[k] = v
	}
	if a.State != "" {
		q.Set("state", a.State)
	}
	u.RawQuery = q.Encode()
	http.Redirect(w, r, u.String(), http.StatusSeeOther)
}

func formUser(f url.Values) (user, bool) {
	if id := f.Get("preset"); id != "" {
		i := slices.IndexFunc(presets, func(u user) bool { return u.ID == id })
		if i < 0 {
			return user{}, false
		}
		return presets[i], true
	}
	u := user{
		Name:          strings.TrimSpace(f.Get("name")),
		Email:         strings.TrimSpace(f.Get("email")),
		EmailVerified: f.Get("email_verified") == "true",
		HD:            strings.TrimSpace(f.Get("hd")),
	}
	return u, u.Email != ""
}

type tokenResponse struct {
	AccessToken string `json:"access_token"`
	TokenType   string `json:"token_type"`
	ExpiresIn   int    `json:"expires_in"`
	IDToken     string `json:"id_token"`
}

type idTokenClaims struct {
	Iss           string `json:"iss"`
	Sub           string `json:"sub"`
	Aud           string `json:"aud"`
	Exp           int64  `json:"exp"`
	Iat           int64  `json:"iat"`
	Nonce         string `json:"nonce,omitempty"`
	Email         string `json:"email"`
	EmailVerified bool   `json:"email_verified"`
	Name          string `json:"name,omitempty"`
	HD            string `json:"hd,omitempty"`
}

func (p *provider) token(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	id, secret, ok := clientCredentials(r)
	if !ok || !equal(id, p.cfg.clientID) || !equal(secret, p.cfg.clientSecret) {
		p.log.Info("token rejected", "reason", "invalid client")
		w.Header().Set("WWW-Authenticate", `Basic realm="devidp"`)
		tokenError(w, http.StatusUnauthorized, "invalid_client", "client_secret_basic with the configured client is required")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxFormBytes)
	if err := r.ParseForm(); err != nil {
		tokenError(w, http.StatusBadRequest, "invalid_request", "malformed form")
		return
	}
	f := r.PostForm
	if f.Get("grant_type") != "authorization_code" {
		tokenError(w, http.StatusBadRequest, "unsupported_grant_type", "only authorization_code is supported")
		return
	}
	if cid := f.Get("client_id"); cid != "" && cid != id {
		tokenError(w, http.StatusBadRequest, "invalid_request", "client_id does not match the credentials")
		return
	}

	g, found := p.take(f.Get("code"))
	var reason string
	switch {
	case !found:
		reason = "unknown, used or expired code"
	case g.clientID != id:
		reason = "code issued to another client"
	case g.redirectURI != f.Get("redirect_uri"):
		reason = "redirect_uri does not match"
	case !verifyPKCE(f.Get("code_verifier"), g.challenge):
		reason = "PKCE verification failed"
	}
	if reason != "" {
		p.log.Info("token rejected", "reason", reason)
		tokenError(w, http.StatusBadRequest, "invalid_grant", reason)
		return
	}

	now := p.now()
	idt, err := p.sign(idTokenClaims{
		Iss:           p.cfg.issuer,
		Sub:           subject(g.user.Email),
		Aud:           id,
		Exp:           now.Add(idTokenTTL).Unix(),
		Iat:           now.Unix(),
		Nonce:         g.nonce,
		Email:         g.user.Email,
		EmailVerified: g.user.EmailVerified,
		Name:          g.user.Name,
		HD:            g.user.HD,
	})
	if err != nil {
		p.log.Error("sign id token", "err", err)
		tokenError(w, http.StatusInternalServerError, "server_error", "")
		return
	}
	p.log.Info("token issued", "email", g.user.Email)
	writeJSON(w, http.StatusOK, tokenResponse{
		AccessToken: rand.Text(),
		TokenType:   "Bearer",
		ExpiresIn:   int(idTokenTTL.Seconds()),
		IDToken:     idt,
	})
}

// take removes the code whatever happens next, so each code is tried once.
func (p *provider) take(code string) (grant, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	g, ok := p.codes[code]
	delete(p.codes, code)
	return g, ok && !p.now().After(g.expires)
}

// clientCredentials reads client_secret_basic, whose parts are form-encoded
// (RFC 6749 section 2.3.1).
func clientCredentials(r *http.Request) (id, secret string, ok bool) {
	rawID, rawSecret, ok := r.BasicAuth()
	if !ok {
		return "", "", false
	}
	id, err1 := url.QueryUnescape(rawID)
	secret, err2 := url.QueryUnescape(rawSecret)
	return id, secret, err1 == nil && err2 == nil
}

func (p *provider) sign(claims any) (string, error) {
	header, err := json.Marshal(map[string]string{"alg": "RS256", "typ": "JWT", "kid": keyID})
	if err != nil {
		return "", err
	}
	payload, err := json.Marshal(claims)
	if err != nil {
		return "", err
	}
	in := b64(header) + "." + b64(payload)
	sum := sha256.Sum256([]byte(in))
	sig, err := rsa.SignPKCS1v15(rand.Reader, p.key, crypto.SHA256, sum[:])
	if err != nil {
		return "", err
	}
	return in + "." + b64(sig), nil
}

// subject is stable per email across restarts.
func subject(email string) string {
	sum := sha256.Sum256([]byte("devidp:" + strings.ToLower(email)))
	return hex.EncodeToString(sum[:16])
}

func s256(verifier string) string {
	sum := sha256.Sum256([]byte(verifier))
	return b64(sum[:])
}

// verifyPKCE follows RFC 7636: 43-128 unreserved characters.
func verifyPKCE(verifier, challenge string) bool {
	if len(verifier) < 43 || len(verifier) > 128 || strings.IndexFunc(verifier, func(r rune) bool { return !unreserved(r) }) >= 0 {
		return false
	}
	return equal(s256(verifier), challenge)
}

func validChallenge(c string) bool {
	b, err := base64.RawURLEncoding.DecodeString(c)
	return err == nil && len(b) == sha256.Size
}

func unreserved(r rune) bool {
	return 'a' <= r && r <= 'z' || 'A' <= r && r <= 'Z' || '0' <= r && r <= '9' || strings.ContainsRune("-._~", r)
}

func equal(a, b string) bool {
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}

func b64(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func tokenError(w http.ResponseWriter, status int, code, desc string) {
	body := map[string]string{"error": code}
	if desc != "" {
		body["error_description"] = desc
	}
	writeJSON(w, status, body)
}

func writeHTML(w http.ResponseWriter, status int, data map[string]any) {
	nonce := rand.Text()
	data["CSPNonce"] = nonce
	var buf bytes.Buffer
	if err := authorizePage.Execute(&buf, data); err != nil {
		http.Error(w, "template: "+err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Security-Policy",
		"default-src 'none'; style-src 'nonce-"+nonce+"'; script-src 'nonce-"+nonce+"'; base-uri 'none'; frame-ancestors 'none'")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.WriteHeader(status)
	_, _ = w.Write(buf.Bytes())
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeHTML(w, status, map[string]any{"Error": msg})
}
