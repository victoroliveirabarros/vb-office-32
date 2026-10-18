package auth

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"errors"
	"fmt"
	"html"
	"log/slog"
	"net/http"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/oauth2"
)

const (
	GoogleIssuer = "https://accounts.google.com"

	flowCookie     = "vb_office32_oidc"
	flowCookiePath = "/auth/"
	flowTTL        = 10 * time.Minute
	httpTimeout    = 10 * time.Second
	maxEmailLen    = 254
	minSessionKey  = 32
)

var (
	errSubject          = errors.New("invalid subject")
	errEmailNotVerified = errors.New("email not verified")
	errEmailDomain      = errors.New("email domain not allowed")
	errHDMissing        = errors.New("hd claim missing")
	errHDDomain         = errors.New("hd domain not allowed")
)

type OIDCConfig struct {
	// PublicURL is the validated scheme://host the browser uses. It is the
	// only source for the redirect URL and the Secure cookie flag.
	PublicURL    string
	Issuer       string
	ClientID     string
	ClientSecret string
	// AllowedDomains must be lowercase.
	AllowedDomains []string
	SessionKey     []byte
	Log            *slog.Logger
}

// OIDC authenticates with an OpenID Connect provider and keeps the result in
// a signed session cookie.
type OIDC struct {
	issuer        string
	clientID      string
	clientSecret  string
	redirectURL   string
	domains       []string
	requireHD     bool
	secure        bool
	sessionCookie string
	session       signer
	flow          signer
	client        *http.Client
	log           *slog.Logger
	now           func() time.Time

	mu        sync.Mutex
	endpoints *endpoints
}

type endpoints struct {
	oauth    oauth2.Config
	verifier *oidc.IDTokenVerifier
}

type flowPayload struct {
	header
	State    string `json:"state"`
	Nonce    string `json:"nonce"`
	Verifier string `json:"verifier"`
}

type idClaims struct {
	Sub           string   `json:"sub"`
	Email         string   `json:"email"`
	EmailVerified flexBool `json:"email_verified"`
	Name          string   `json:"name"`
	HD            string   `json:"hd"`
}

// flexBool accepts true and "true"; some providers send the string.
type flexBool bool

func (b *flexBool) UnmarshalJSON(data []byte) error {
	s := string(data)
	*b = s == "true" || s == `"true"`
	return nil
}

// NewOIDC does no network I/O; provider discovery happens on first login.
func NewOIDC(cfg OIDCConfig) (*OIDC, error) {
	if len(cfg.SessionKey) < minSessionKey {
		return nil, fmt.Errorf("session key must have at least %d bytes", minSessionKey)
	}
	if len(cfg.AllowedDomains) == 0 {
		return nil, errors.New("no allowed domains")
	}
	session, err := newSigner(cfg.SessionKey, purposeSession)
	if err != nil {
		return nil, err
	}
	flow, err := newSigner(cfg.SessionKey, purposeFlow)
	if err != nil {
		return nil, err
	}
	o := &OIDC{
		issuer:        cfg.Issuer,
		clientID:      cfg.ClientID,
		clientSecret:  cfg.ClientSecret,
		redirectURL:   strings.TrimSuffix(cfg.PublicURL, "/") + "/auth/callback",
		domains:       cfg.AllowedDomains,
		requireHD:     cfg.Issuer == GoogleIssuer,
		secure:        strings.HasPrefix(cfg.PublicURL, "https://"),
		sessionCookie: sessionCookie,
		session:       session,
		flow:          flow,
		client:        &http.Client{Timeout: httpTimeout},
		log:           cfg.Log,
		now:           time.Now,
	}
	if o.secure {
		o.sessionCookie = hostPrefix + sessionCookie
	}
	return o, nil
}

// discover fetches provider metadata once it succeeds; failures are retried
// on the next login so a provider that is briefly unreachable at boot does
// not need a restart.
func (o *OIDC) discover(ctx context.Context) (*endpoints, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.endpoints != nil {
		return o.endpoints, nil
	}
	p, err := oidc.NewProvider(oidc.ClientContext(ctx, o.client), o.issuer)
	if err != nil {
		return nil, err
	}
	// client_secret_basic is the OIDC default; auto-detection would retry a
	// refused exchange with the secret in the body.
	endpoint := p.Endpoint()
	endpoint.AuthStyle = oauth2.AuthStyleInHeader
	o.endpoints = &endpoints{
		oauth: oauth2.Config{
			ClientID:     o.clientID,
			ClientSecret: o.clientSecret,
			Endpoint:     endpoint,
			RedirectURL:  o.redirectURL,
			Scopes:       []string{oidc.ScopeOpenID, "email", "profile"},
		},
		verifier: p.Verifier(&oidc.Config{
			ClientID: o.clientID,
			Now:      func() time.Time { return o.now() },
		}),
	}
	return o.endpoints, nil
}

func (o *OIDC) Login(w http.ResponseWriter, r *http.Request) {
	noStore(w)
	ep, err := o.discover(r.Context())
	if err != nil {
		o.log.Warn("oidc discovery failed", "err", err)
		writePage(w, http.StatusServiceUnavailable, "Login indisponível no momento. Tente de novo em instantes.")
		return
	}
	f := flowPayload{
		header:   newHeader(o.now().Add(flowTTL)),
		State:    rand.Text(),
		Nonce:    rand.Text(),
		Verifier: oauth2.GenerateVerifier(),
	}
	token, err := o.flow.seal(&f)
	if err != nil {
		o.log.Error("seal login flow", "err", err)
		writePage(w, http.StatusInternalServerError, "Erro interno.")
		return
	}
	http.SetCookie(w, o.cookie(flowCookie, flowCookiePath, token, int(flowTTL.Seconds())))

	opts := []oauth2.AuthCodeOption{oidc.Nonce(f.Nonce), oauth2.S256ChallengeOption(f.Verifier)}
	if o.requireHD && len(o.domains) == 1 {
		opts = append(opts, oauth2.SetAuthURLParam("hd", o.domains[0]))
	}
	http.Redirect(w, r, ep.oauth.AuthCodeURL(f.State, opts...), http.StatusFound)
}

// Callback never echoes provider parameters and logs only the subject and
// the reason for a denial.
func (o *OIDC) Callback(w http.ResponseWriter, r *http.Request) {
	noStore(w)
	w.Header().Set("Referrer-Policy", "no-referrer")
	http.SetCookie(w, o.cookie(flowCookie, flowCookiePath, "", -1))

	var f flowPayload
	q := r.URL.Query()
	c, err := r.Cookie(flowCookie)
	if err != nil || o.flow.open(c.Value, o.now(), &f) != nil ||
		subtle.ConstantTimeCompare([]byte(q.Get("state")), []byte(f.State)) != 1 {
		o.log.Info("login rejected", "reason", "invalid login flow")
		writePage(w, http.StatusBadRequest, "Sessão de login expirada. Tente de novo.")
		return
	}
	if q.Has("error") || q.Get("code") == "" {
		o.log.Info("login rejected", "reason", "provider returned no code")
		writePage(w, http.StatusForbidden, "O provedor não concluiu o login.")
		return
	}

	ep, err := o.discover(r.Context())
	if err != nil {
		o.log.Warn("oidc discovery failed", "err", err)
		writePage(w, http.StatusServiceUnavailable, "Login indisponível no momento. Tente de novo em instantes.")
		return
	}
	ctx := oidc.ClientContext(r.Context(), o.client)
	tok, err := ep.oauth.Exchange(ctx, q.Get("code"), oauth2.VerifierOption(f.Verifier))
	if err != nil {
		if re, ok := errors.AsType[*oauth2.RetrieveError](err); ok {
			o.log.Warn("login rejected", "reason", "token exchange refused", "error_code", re.ErrorCode)
			writePage(w, http.StatusForbidden, "Acesso negado.")
			return
		}
		o.log.Warn("token exchange failed", "err", err)
		writePage(w, http.StatusBadGateway, "Login indisponível no momento. Tente de novo em instantes.")
		return
	}
	raw, _ := tok.Extra("id_token").(string)
	idt, err := ep.verifier.Verify(ctx, raw)
	if err != nil {
		o.log.Warn("login rejected", "reason", "invalid id token", "err", err)
		writePage(w, http.StatusForbidden, "Acesso negado.")
		return
	}
	if subtle.ConstantTimeCompare([]byte(idt.Nonce), []byte(f.Nonce)) != 1 {
		o.log.Warn("login rejected", "reason", "nonce mismatch")
		writePage(w, http.StatusForbidden, "Acesso negado.")
		return
	}
	var claims idClaims
	if err := idt.Claims(&claims); err != nil {
		o.log.Warn("login rejected", "reason", "invalid claims")
		writePage(w, http.StatusForbidden, "Acesso negado.")
		return
	}
	if err := authorize(claims, o.domains, o.requireHD); err != nil {
		attrs := []any{"reason", err.Error()}
		if validSubject(claims.Sub) {
			attrs = append(attrs, "id", oidcIdentPrefix+claims.Sub)
		}
		o.log.Info("login denied", attrs...)
		writePage(w, http.StatusForbidden, "Acesso negado: esta conta não tem permissão para entrar.")
		return
	}
	if err := o.setSession(w, claims); err != nil {
		o.log.Error("seal session", "err", err)
		writePage(w, http.StatusInternalServerError, "Erro interno.")
		return
	}
	o.log.Info("login", "id", oidcIdentPrefix+claims.Sub)
	http.Redirect(w, r, "/", http.StatusSeeOther)
}

func (o *OIDC) Logout(w http.ResponseWriter, _ *http.Request) {
	noStore(w)
	o.clearSession(w)
	w.WriteHeader(http.StatusNoContent)
}

// authorize decides who may enter. The Google issuer must also send hd, which
// only Workspace accounts carry: a personal Google account registered with a
// company address has a verified email in the domain but no hd.
func authorize(c idClaims, allowed []string, requireHD bool) error {
	if !validSubject(c.Sub) {
		return errSubject
	}
	if !c.EmailVerified {
		return errEmailNotVerified
	}
	return checkDomains(c.Email, c.HD, allowed, requireHD)
}

func checkDomains(email, hd string, allowed []string, requireHD bool) error {
	if len(email) > maxEmailLen || !slices.Contains(allowed, emailDomain(email)) {
		return errEmailDomain
	}
	if hd == "" {
		if requireHD {
			return errHDMissing
		}
		return nil
	}
	if !slices.Contains(allowed, strings.ToLower(hd)) {
		return errHDDomain
	}
	return nil
}

func emailDomain(email string) string {
	i := strings.LastIndexByte(email, '@')
	if i <= 0 {
		return ""
	}
	return strings.ToLower(email[i+1:])
}

func noStore(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "no-store")
}

func writePage(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	fmt.Fprintf(w, `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>vb-office-32</title><p>%s</p><p><a href="/">Voltar</a></p></html>`, html.EscapeString(msg))
}
