package auth

import (
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

var newKey = []byte(strings.Repeat("n", 32))

// rotate builds a server for the harness' provider and clock with the given
// keys, as a deploy after a rotation would.
func (h *harness) rotate(current, previous []byte) *OIDC {
	h.t.Helper()
	o, err := NewOIDC(OIDCConfig{
		PublicURL:          "https://office.example",
		Issuer:             h.idp.srv.URL,
		ClientID:           testClientID,
		ClientSecret:       testClientSecret,
		AllowedDomains:     []string{"example.com", "example.org"},
		SessionKey:         current,
		PreviousSessionKey: previous,
		Log:                slog.New(slog.DiscardHandler),
	})
	if err != nil {
		h.t.Fatal(err)
	}
	o.now = h.clock.now
	return o
}

func authenticate(o *OIDC, c *http.Cookie) (Identity, error) {
	req := httptest.NewRequest("GET", "/ws", nil)
	req.AddCookie(c)
	return o.Authenticate(req)
}

func TestSessionKeyRotation(t *testing.T) {
	h := newHarness(t, "https://office.example")
	old := h.login()
	inFlight := h.startLogin()

	rotated := h.rotate(newKey, testKey)
	newOnly := h.rotate(newKey, nil)

	if id, err := authenticate(rotated, old); err != nil || id.ID != "oidc:"+testSub {
		t.Errorf("old cookie with the previous key = %+v, %v, want accepted", id, err)
	}
	if _, err := authenticate(newOnly, old); !errors.Is(err, ErrNoSession) {
		t.Errorf("old cookie without the previous key: err = %v, want ErrNoSession", err)
	}

	// A login started before the deploy finishes after it.
	res := serve(rotated.Callback, inFlight)
	fresh := findCookie(res, rotated.sessionCookie)
	if res.StatusCode != http.StatusSeeOther || fresh == nil {
		t.Fatalf("callback with an old flow cookie = %d, session %v", res.StatusCode, fresh)
	}
	if _, err := authenticate(newOnly, fresh); err != nil {
		t.Errorf("new cookie does not verify with the current key alone: %v", err)
	}
	if _, err := h.authenticate(fresh); !errors.Is(err, ErrNoSession) {
		t.Errorf("new cookie verifies with the previous key: err = %v", err)
	}

	res = serve(rotated.Login, httptest.NewRequest("GET", "/auth/login", nil))
	flow := findCookie(res, rotated.flowCookie)
	var f flowPayload
	if flow == nil || newOnly.flow.open(flow.Value, h.clock.now(), &f) != nil {
		t.Errorf("flow cookie %v is not signed with the current key", flow)
	}
}

func TestNewOIDCRejectsShortPreviousKey(t *testing.T) {
	_, err := NewOIDC(OIDCConfig{AllowedDomains: []string{"example.com"}, SessionKey: testKey, PreviousSessionKey: make([]byte, 31)})
	if err == nil {
		t.Error("NewOIDC accepted a 31-byte previous key")
	}
}
