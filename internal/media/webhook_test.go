package media

import (
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// capturedToken and capturedBody are a webhook LiveKit v1.13 sent with key
// devkey and secret secret.
const (
	capturedToken = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJkZXZrZXkiLCJleHAiOjE3OTIzNTQ2NDYsIm5iZiI6MTc5MjM1NDM0NiwiaWF0IjoxNzkyMzU0MzQ2LCJzaGEyNTYiOiJ3c1FVTE9qVVpCblJRbzllQVRoMlVHZktFcUZiMlpZWHVyWmNnTCtwVG5rPSJ9.jZ7xbnTb0krWdUUCC9USOjjVPaJ6ls3_Z7PXGuhIi1s"
	capturedBody  = `{"event":"participant_connection_aborted", "room":{"sid":"RM_V5W4HCs8iZbW", "name":"remove-test-dm88l7r0uebd", "emptyTimeout":300, "departureTimeout":20, "creationTime":"1792354346", "creationTimeMs":"1792354346819", "turnPassword":"kMKvaotbq5nbJGn1f9478ffAYYwjCZLJ3vH13rMhfdhC", "enabledCodecs":[{"mime":"audio/PCMU"}, {"mime":"audio/PCMA"}, {"mime":"audio/opus"}, {"mime":"audio/red"}, {"mime":"video/VP8"}, {"mime":"video/H264"}, {"mime":"video/VP9"}, {"mime":"video/AV1"}, {"mime":"video/H265"}, {"mime":"video/rtx"}]}, "participant":{"sid":"PA_YoBhYUkrSZSQ", "identity":"guest:ana", "state":"DISCONNECTED", "joinedAt":"1792354346", "joinedAtMs":"1792354346820", "name":"Ana", "version":2, "permission":{"canSubscribe":true, "canPublish":true, "canPublishSources":["MICROPHONE", "CAMERA"]}, "disconnectReason":"PARTICIPANT_REMOVED"}, "id":"EV_hvgqjtKG4PZ2", "createdAt":"1792354346"}`
)

func webhookRequest(token, contentType, body string) *http.Request {
	r := httptest.NewRequest(http.MethodPost, "/livekit/webhook", strings.NewReader(body))
	r.Header.Set("Authorization", token)
	r.Header.Set("Content-Type", contentType)
	return r
}

func TestReadEventFromLiveKit(t *testing.T) {
	c := NewClient("ws://localhost:7880", "devkey", "secret")
	ev, err := c.ReadEvent(webhookRequest(capturedToken, "application/webhook+json", capturedBody), time.Unix(1792354346, 0))
	if err != nil {
		t.Fatal(err)
	}
	if want := (Event{"participant_connection_aborted", "remove-test-dm88l7r0uebd", "guest:ana"}); ev != want {
		t.Errorf("event = %+v, want %+v", ev, want)
	}
}

// signWebhook signs body the way LiveKit does.
func signWebhook(t *testing.T, key, secret, body string, nbf time.Time) string {
	t.Helper()
	sum := sha256.Sum256([]byte(body))
	token, err := sign(webhookClaims{
		Iss:    key,
		Nbf:    nbf.Unix(),
		Exp:    nbf.Add(5 * time.Minute).Unix(),
		Sha256: base64.StdEncoding.EncodeToString(sum[:]),
	}, []byte(secret))
	if err != nil {
		t.Fatal(err)
	}
	return token
}

func TestReadEvent(t *testing.T) {
	const body = `{"event":"participant_joined","room":{"name":"office"},"participant":{"identity":"guest:ana","state":"ACTIVE"}}`
	now := time.Unix(1_800_000_000, 0)
	c := NewClient("ws://localhost:7880", "devkey", "secret")
	valid := signWebhook(t, "devkey", "secret", body, now)
	parts := strings.Split(valid, ".")

	tests := []struct {
		name        string
		token       string
		contentType string
		body        string
		now         time.Time
		err         error
	}{
		{"valid", valid, "application/webhook+json", body, now, nil},
		{"bearer", "Bearer " + valid, "application/webhook+json; charset=utf-8", body, now, nil},
		{"clock behind", valid, "application/webhook+json", body, now.Add(-clockSkew), nil},
		{"no token", "", "application/webhook+json", body, now, ErrUnauthorized},
		{"wrong secret", signWebhook(t, "devkey", "other", body, now), "application/webhook+json", body, now, ErrUnauthorized},
		{"wrong key", signWebhook(t, "other", "secret", body, now), "application/webhook+json", body, now, ErrUnauthorized},
		{"alg none", "eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0." + parts[1] + ".", "application/webhook+json", body, now, ErrUnauthorized},
		{"tampered body", valid, "application/webhook+json", strings.Replace(body, "ana", "bob", 1), now, ErrUnauthorized},
		{"expired", valid, "application/webhook+json", body, now.Add(5*time.Minute + clockSkew), ErrUnauthorized},
		{"not yet valid", valid, "application/webhook+json", body, now.Add(-clockSkew - time.Second), ErrUnauthorized},
		{"wrong content type", valid, "application/json", body, now, errors.New("")},
		{"too large", valid, "application/webhook+json", body + strings.Repeat(" ", maxWebhookBody), now, errors.New("")},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ev, err := c.ReadEvent(webhookRequest(tt.token, tt.contentType, tt.body), tt.now)
			switch {
			case tt.err == nil && err != nil:
				t.Fatalf("err = %v", err)
			case tt.err == nil:
				if want := (Event{"participant_joined", "office", "guest:ana"}); ev != want {
					t.Errorf("event = %+v, want %+v", ev, want)
				}
			case err == nil:
				t.Fatalf("accepted, event = %+v", ev)
			case errors.Is(tt.err, ErrUnauthorized) != errors.Is(err, ErrUnauthorized):
				t.Errorf("err = %v, want unauthorized = %v", err, errors.Is(tt.err, ErrUnauthorized))
			}
			if err != nil && strings.Contains(err.Error(), parts[2]) {
				t.Errorf("error %q carries the token", err)
			}
		})
	}
}
