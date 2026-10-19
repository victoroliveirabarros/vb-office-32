package media

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"
)

var now = time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)

func TestIssue(t *testing.T) {
	i := NewClient("wss://media.example", "key", "s3cr3t")
	g, err := i.Issue("oidc:42", "Zé", "office", now.Add(300*time.Millisecond))
	if err != nil {
		t.Fatal(err)
	}
	if g.URL != "wss://media.example" || !g.ExpiresAt.Equal(now.Add(TTL)) {
		t.Errorf("grant = %s %v, want url and expiry %v", g.URL, g.ExpiresAt, now.Add(TTL))
	}

	parts := strings.Split(g.Token, ".")
	if len(parts) != 3 {
		t.Fatalf("token has %d parts, want 3", len(parts))
	}
	if got := decode(t, parts[0]); got != `{"alg":"HS256","typ":"JWT"}` {
		t.Errorf("header = %s", got)
	}
	mac := hmac.New(sha256.New, []byte("s3cr3t"))
	mac.Write([]byte(parts[0] + "." + parts[1]))
	if got := decode(t, parts[2]); !hmac.Equal([]byte(got), mac.Sum(nil)) {
		t.Error("signature is not HMAC-SHA256 of header.payload with the raw secret")
	}
	if strings.ContainsAny(g.Token, "=+/") {
		t.Errorf("token %q is not unpadded base64url", g.Token)
	}

	want := `{"iss":"key","sub":"oidc:42","name":"Zé","nbf":1767268800,"iat":1767268800,"exp":1767269400,` +
		`"video":{"room":"office","roomJoin":true,"canPublish":true,"canPublishSources":["microphone","camera","screen_share"],` +
		`"canSubscribe":true,"canPublishData":false,"canUpdateOwnMetadata":false}}`
	payload := decode(t, parts[1])
	if payload != want {
		t.Errorf("payload =\n%s\nwant\n%s", payload, want)
	}
	var c claims
	if err := json.Unmarshal([]byte(payload), &c); err != nil {
		t.Fatal(err)
	}
	if c.Exp-c.Nbf != int64(TTL/time.Second) {
		t.Errorf("exp - nbf = %d, want %d", c.Exp-c.Nbf, int64(TTL/time.Second))
	}
}

func decode(t *testing.T, s string) string {
	t.Helper()
	b, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		t.Fatalf("decode %q: %v", s, err)
	}
	return string(b)
}

// TestLiveKitValidate checks tokens against a real LiveKit server in dev mode
// (API key devkey, secret secret), e.g.
//
//	docker run --rm --network host livekit/livekit-server:v1.13 --dev
//	VB_OFFICE32_LIVEKIT_TEST_URL=http://localhost:7880 go test -run LiveKit ./internal/media
func TestLiveKitValidate(t *testing.T) {
	base := os.Getenv("VB_OFFICE32_LIVEKIT_TEST_URL")
	if base == "" {
		t.Skip("VB_OFFICE32_LIVEKIT_TEST_URL not set")
	}
	const key, secret = "devkey", "secret"
	issued := func(secret string, at time.Time) string {
		g, err := NewClient("ws://unused", key, secret).Issue("guest:ana", "Ana", "office", at)
		if err != nil {
			t.Fatal(err)
		}
		return g.Token
	}
	noJoin := func() string {
		at := time.Now()
		token, err := sign(claims{
			Iss: key, Sub: "guest:ana", Name: "Ana",
			Nbf: at.Unix(), Iat: at.Unix(), Exp: at.Add(TTL).Unix(),
			Video: videoGrant{Room: "office", CanPublish: true, CanSubscribe: true},
		}, []byte(secret))
		if err != nil {
			t.Fatal(err)
		}
		return token
	}

	tests := []struct {
		name  string
		token string
		want  int
	}{
		{"valid", issued(secret, time.Now()), http.StatusOK},
		{"wrong secret", issued("not-the-secret", time.Now()), http.StatusUnauthorized},
		{"expired", issued(secret, time.Now().Add(-TTL-2*time.Minute)), http.StatusUnauthorized},
		{"without roomJoin", noJoin(), http.StatusUnauthorized},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			u := base + "/rtc/validate?access_token=" + url.QueryEscape(tt.token)
			req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
			if err != nil {
				t.Fatal(err)
			}
			res, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			res.Body.Close()
			if res.StatusCode != tt.want {
				t.Errorf("status = %d, want %d", res.StatusCode, tt.want)
			}
		})
	}
}
