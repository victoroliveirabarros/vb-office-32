package media

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"strings"
	"time"
)

const (
	maxWebhookBody = 1 << 20
	// clockSkew is how far the LiveKit clock may be from ours.
	clockSkew = 30 * time.Second
)

// ErrUnauthorized marks a webhook that LiveKit did not sign with our key.
var ErrUnauthorized = errors.New("webhook not signed by the media server")

// Event is a LiveKit webhook notification. Identity is empty for events
// about the room as a whole.
type Event struct {
	Event    string
	Room     string
	Identity string
}

type webhookClaims struct {
	Iss    string `json:"iss"`
	Nbf    int64  `json:"nbf"`
	Exp    int64  `json:"exp"`
	Sha256 string `json:"sha256"`
}

// ReadEvent verifies that LiveKit signed r with our API key and secret and
// decodes it. Errors never carry the token.
func (c *Client) ReadEvent(r *http.Request, now time.Time) (Event, error) {
	if mt, _, err := mime.ParseMediaType(r.Header.Get("Content-Type")); err != nil || mt != "application/webhook+json" {
		return Event{}, errors.New("webhook: content type is not application/webhook+json")
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, maxWebhookBody+1))
	if err != nil {
		return Event{}, fmt.Errorf("webhook: %w", err)
	}
	if len(body) > maxWebhookBody {
		return Event{}, errors.New("webhook: body too large")
	}
	token, _ := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	if err := c.verifyWebhook(token, body, now); err != nil {
		return Event{}, err
	}

	var ev struct {
		Event string `json:"event"`
		Room  struct {
			Name string `json:"name"`
		} `json:"room"`
		Participant struct {
			Identity string `json:"identity"`
		} `json:"participant"`
	}
	if err := json.Unmarshal(body, &ev); err != nil {
		return Event{}, fmt.Errorf("webhook: %w", err)
	}
	return Event{Event: ev.Event, Room: ev.Room.Name, Identity: ev.Participant.Identity}, nil
}

func (c *Client) verifyWebhook(token string, body []byte, now time.Time) error {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return fmt.Errorf("%w: malformed token", ErrUnauthorized)
	}
	var header struct {
		Alg string `json:"alg"`
	}
	if err := decodeSegment(parts[0], &header); err != nil || header.Alg != "HS256" {
		return fmt.Errorf("%w: not HS256", ErrUnauthorized)
	}
	sig, err := base64.RawURLEncoding.DecodeString(parts[2])
	mac := hmac.New(sha256.New, c.secret)
	mac.Write([]byte(parts[0] + "." + parts[1]))
	if err != nil || !hmac.Equal(sig, mac.Sum(nil)) {
		return fmt.Errorf("%w: bad signature", ErrUnauthorized)
	}

	var claims webhookClaims
	if err := decodeSegment(parts[1], &claims); err != nil {
		return fmt.Errorf("%w: bad claims", ErrUnauthorized)
	}
	switch {
	case claims.Iss != c.key:
		return fmt.Errorf("%w: unknown issuer", ErrUnauthorized)
	case now.Add(clockSkew).Unix() < claims.Nbf, now.Add(-clockSkew).Unix() >= claims.Exp:
		return fmt.Errorf("%w: expired or not yet valid", ErrUnauthorized)
	}
	sum := sha256.Sum256(body)
	want := base64.StdEncoding.EncodeToString(sum[:])
	if !hmac.Equal([]byte(claims.Sha256), []byte(want)) {
		return fmt.Errorf("%w: body does not match", ErrUnauthorized)
	}
	return nil
}

func decodeSegment(s string, v any) error {
	b, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		return err
	}
	return json.Unmarshal(b, v)
}
