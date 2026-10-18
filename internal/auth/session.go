package auth

import (
	"errors"
	"net/http"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

const (
	sessionTTL      = 12 * time.Hour
	sessionCookie   = "vb_office32_session"
	hostPrefix      = "__Host-"
	maxNameRunes    = 32
	fallbackName    = "user"
	oidcIdentPrefix = "oidc:"
)

var ErrNoSession = errors.New("no valid session")

type sessionPayload struct {
	header
	Sub    string `json:"sub"`
	Name   string `json:"name"`
	Domain string `json:"domain"`
	HD     string `json:"hd,omitempty"`
}

// Authenticate reads the session cookie. Domains are checked again on every
// call, so removing one from the configuration revokes its sessions.
func (o *OIDC) Authenticate(r *http.Request) (Identity, error) {
	c, err := r.Cookie(o.sessionCookie)
	if err != nil {
		return Identity{}, ErrNoSession
	}
	var p sessionPayload
	if err := o.session.open(c.Value, o.now(), &p); err != nil {
		return Identity{}, ErrNoSession
	}
	if checkDomains(p.Domain, p.HD, o.domains, o.requireHD) != nil || !validSubject(p.Sub) {
		return Identity{}, ErrNoSession
	}
	return Identity{ID: oidcIdentPrefix + p.Sub, Name: p.Name, Expires: time.Unix(p.Exp, 0)}, nil
}

// setSession keeps only the email domain; the display name fallback is taken
// from the email here, before it is discarded.
func (o *OIDC) setSession(w http.ResponseWriter, c idClaims) error {
	token, err := o.session.seal(&sessionPayload{
		header: newHeader(o.now().Add(sessionTTL)),
		Sub:    c.Sub,
		Name:   displayName(c.Name, c.Email),
		Domain: emailDomain(c.Email),
		HD:     c.HD,
	})
	if err != nil {
		return err
	}
	http.SetCookie(w, o.cookie(o.sessionCookie, token, int(sessionTTL.Seconds())))
	return nil
}

func (o *OIDC) clearSession(w http.ResponseWriter) {
	http.SetCookie(w, o.cookie(o.sessionCookie, "", -1))
}

// cookie always uses Path=/ because the __Host- prefix requires it.
func (o *OIDC) cookie(name, value string, maxAge int) *http.Cookie {
	return &http.Cookie{
		Name:     name,
		Value:    value,
		Path:     "/",
		MaxAge:   maxAge,
		HttpOnly: true,
		Secure:   o.secure,
		SameSite: http.SameSiteLaxMode,
	}
}

// displayName cleans the provider's name claim and falls back to the local
// part of the email.
func displayName(name, email string) string {
	if n := cleanName(name); n != "" {
		return n
	}
	if i := strings.LastIndexByte(email, '@'); i > 0 {
		if n := cleanName(email[:i]); n != "" {
			return n
		}
	}
	return fallbackName
}

func cleanName(s string) string {
	s = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) || unicode.Is(unicode.Cf, r) {
			return -1
		}
		return r
	}, strings.ToValidUTF8(s, ""))
	s = strings.TrimSpace(s)
	if utf8.RuneCountInString(s) > maxNameRunes {
		s = strings.TrimSpace(string([]rune(s)[:maxNameRunes]))
	}
	return s
}

// validSubject follows OIDC Core: at most 255 ASCII characters.
func validSubject(sub string) bool {
	if sub == "" || len(sub) > 255 {
		return false
	}
	for _, c := range []byte(sub) {
		if c <= ' ' || c > '~' {
			return false
		}
	}
	return true
}
