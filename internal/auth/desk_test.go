package auth

import (
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

var testDesks = map[string]string{testEmail: "mesa-01", "bruno@example.com": "mesa-02"}

// withDesks builds a server for the harness' provider, clock and logs with
// the given desks and keys.
func (h *harness) withDesks(desks map[string]string, current, previous []byte) *OIDC {
	h.t.Helper()
	o, err := NewOIDC(OIDCConfig{
		PublicURL:          "https://office.example",
		Issuer:             h.idp.srv.URL,
		ClientID:           testClientID,
		ClientSecret:       testClientSecret,
		AllowedDomains:     []string{"example.com", "example.org"},
		SessionKey:         current,
		PreviousSessionKey: previous,
		Desks:              desks,
		Log:                slog.New(slog.NewJSONHandler(h.logs, nil)),
	})
	if err != nil {
		h.t.Fatal(err)
	}
	o.now = h.clock.now
	return o
}

func TestDeskOwner(t *testing.T) {
	h := newHarness(t, "https://office.example")
	h.o = h.withDesks(testDesks, testKey, nil)
	h.idp.set(func(idp *fakeIDP) {
		idp.claims = func(c map[string]any) { c["email"] = "Ana@Example.COM" }
	})
	sess := h.login()
	if id, err := h.authenticate(sess); err != nil || id.Desk != "mesa-01" {
		t.Errorf("identity = %+v, %v; want desk mesa-01", id, err)
	}

	// The configuration of the process decides, not the cookie.
	moved := h.withDesks(map[string]string{testEmail: "mesa-07"}, testKey, nil)
	if id, err := authenticate(moved, sess); err != nil || id.Desk != "mesa-07" {
		t.Errorf("after the desk moved: %+v, %v; want mesa-07", id, err)
	}
	if id, err := authenticate(h.withDesks(nil, testKey, nil), sess); err != nil || id.Desk != "" {
		t.Errorf("without desks: %+v, %v; want none", id, err)
	}

	h.idp.set(func(idp *fakeIDP) {
		idp.claims = func(c map[string]any) { c["email"] = "carla@example.com" }
	})
	if id, err := h.authenticate(h.login()); err != nil || id.Desk != "" {
		t.Errorf("email without a desk: %+v, %v", id, err)
	}
	if logs := h.logs.String(); strings.Contains(logs, "@") || strings.Contains(logs, "example.com") {
		t.Errorf("logs mention the email: %s", logs)
	}
}

func TestDeskTagRotation(t *testing.T) {
	h := newHarness(t, "https://office.example")
	h.o = h.withDesks(testDesks, testKey, nil)
	old := h.login()

	rotated := h.withDesks(testDesks, newKey, testKey)
	if id, err := authenticate(rotated, old); err != nil || id.Desk != "mesa-01" {
		t.Errorf("tag of the previous key = %+v, %v; want mesa-01", id, err)
	}
	h.o = rotated
	fresh := h.login()
	if id, err := authenticate(h.withDesks(testDesks, newKey, nil), fresh); err != nil || id.Desk != "mesa-01" {
		t.Errorf("tag of the current key = %+v, %v; want mesa-01", id, err)
	}
	if h.et(old) == h.et(fresh) {
		t.Error("tags of two keys are equal")
	}
	if len(h.et(fresh)) != 22 {
		t.Errorf("tag %q, want 16 bytes in base64url", h.et(fresh))
	}
}

// et reads the desk tag in a session cookie of either test key.
func (h *harness) et(c *http.Cookie) string {
	t := h.t
	t.Helper()
	var p sessionPayload
	s, err := newSigner(purposeSession, testKey, newKey)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.open(c.Value, h.clock.now(), &p); err != nil {
		t.Fatal(err)
	}
	return p.ET
}

func TestDeskNeedsTag(t *testing.T) {
	h := newHarness(t, "https://office.example")
	h.o = h.withDesks(testDesks, testKey, nil)

	// A cookie from before desks has no tag and no desk until next login.
	token, err := h.o.session.seal(&sessionPayload{
		header: newHeader(h.clock.now().Add(time.Hour)), Sub: testSub, Name: "Ana", Domain: "example.com",
	})
	if err != nil {
		t.Fatal(err)
	}
	if id, err := h.authenticate(&http.Cookie{Name: h.o.sessionCookie, Value: token}); err != nil || id.Desk != "" {
		t.Errorf("cookie without et = %+v, %v; want no desk", id, err)
	}

	// setSession tags only a verified email, whoever calls it.
	rec := httptest.NewRecorder()
	if err := h.o.setSession(rec, idClaims{Sub: testSub, Email: testEmail}); err != nil {
		t.Fatal(err)
	}
	c := findCookie(rec.Result(), h.o.sessionCookie)
	if id, err := h.authenticate(c); err != nil || id.Desk != "" || h.et(c) != "" {
		t.Errorf("unverified email = %+v, %v; want no tag", id, err)
	}

	h.idp.set(func(idp *fakeIDP) {
		idp.claims = func(c map[string]any) { c["email_verified"] = false }
	})
	res := serve(h.o.Callback, h.startLogin())
	if res.StatusCode != http.StatusForbidden || findCookie(res, h.o.sessionCookie) != nil {
		t.Errorf("unverified login = %d", res.StatusCode)
	}
	keys, err := deskKeys(testKey)
	if err != nil {
		t.Fatal(err)
	}
	if logs := h.logs.String(); strings.Contains(logs, "@") || strings.Contains(logs, deskTag(keys[0], testEmail)) {
		t.Errorf("logs mention the email or its tag: %s", logs)
	}
}

func TestGuestDesk(t *testing.T) {
	g := Guest{Desks: map[string]string{"ana": "mesa-01", "bruno": "mesa-02"}}
	for name, want := range map[string]string{"Ana": "mesa-01", " BRUNO ": "mesa-02", "ana2": "", "dani": ""} {
		r := httptest.NewRequest("GET", "/ws?name="+url.QueryEscape(name), nil)
		id, err := g.Authenticate(r)
		if err != nil || id.Desk != want {
			t.Errorf("%q: %+v, %v; want desk %q", name, id, err, want)
		}
	}
	r := httptest.NewRequest("GET", "/ws?name=ana", nil)
	if id, _ := (Guest{}).Authenticate(r); id.Desk != "" {
		t.Errorf("without desks: %+v", id)
	}
}
