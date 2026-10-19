// Package media issues LiveKit access tokens and removes participants
// through the LiveKit room service.
package media

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"strings"
	"time"
)

// TTL is short because LiveKit refreshes the token of a connected
// participant by itself; ours only has to last until the next connect.
const TTL = 10 * time.Minute

// jwtHeader is base64url({"alg":"HS256","typ":"JWT"}).
const jwtHeader = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"

type Grant struct {
	URL       string
	Token     string
	ExpiresAt time.Time
}

// Client signs LiveKit access tokens with the API key and secret shared with
// the LiveKit server and calls its room service.
type Client struct {
	url    string
	apiURL string
	key    string
	secret []byte
	http   *http.Client
}

// NewClient takes the ws(s):// URL browsers connect to; the room service is
// reached at the same host over http(s).
func NewClient(url, apiKey, apiSecret string) *Client {
	return &Client{
		url:    url,
		apiURL: HTTPURL(url),
		key:    apiKey,
		secret: []byte(apiSecret),
		http:   &http.Client{Timeout: requestTimeout},
	}
}

// HTTPURL turns a ws:// or wss:// URL into its http:// or https://
// counterpart.
func HTTPURL(wsURL string) string {
	if rest, ok := strings.CutPrefix(wsURL, "wss://"); ok {
		return "https://" + rest
	}
	if rest, ok := strings.CutPrefix(wsURL, "ws://"); ok {
		return "http://" + rest
	}
	return wsURL
}

type claims struct {
	Iss   string     `json:"iss"`
	Sub   string     `json:"sub"`
	Name  string     `json:"name"`
	Nbf   int64      `json:"nbf"`
	Iat   int64      `json:"iat"`
	Exp   int64      `json:"exp"`
	Video videoGrant `json:"video"`
}

// videoGrant has no omitempty: LiveKit treats a missing canPublishData as
// equal to canPublish.
type videoGrant struct {
	Room                 string   `json:"room"`
	RoomJoin             bool     `json:"roomJoin"`
	CanPublish           bool     `json:"canPublish"`
	CanPublishSources    []string `json:"canPublishSources"`
	CanSubscribe         bool     `json:"canSubscribe"`
	CanPublishData       bool     `json:"canPublishData"`
	CanUpdateOwnMetadata bool     `json:"canUpdateOwnMetadata"`
}

// Issue grants identity, shown as name, the right to join room, publish its
// microphone and camera and subscribe to others.
func (c *Client) Issue(identity, name, room string, now time.Time) (Grant, error) {
	exp := now.Add(TTL)
	token, err := sign(claims{
		Iss:  c.key,
		Sub:  identity,
		Name: name,
		Nbf:  now.Unix(),
		Iat:  now.Unix(),
		Exp:  exp.Unix(),
		Video: videoGrant{
			Room:              room,
			RoomJoin:          true,
			CanPublish:        true,
			CanPublishSources: []string{"microphone", "camera"},
			CanSubscribe:      true,
		},
	}, c.secret)
	if err != nil {
		return Grant{}, err
	}
	return Grant{URL: c.url, Token: token, ExpiresAt: time.Unix(exp.Unix(), 0)}, nil
}

func sign(c any, secret []byte) (string, error) {
	b, err := json.Marshal(c)
	if err != nil {
		return "", err
	}
	signed := jwtHeader + "." + base64.RawURLEncoding.EncodeToString(b)
	h := hmac.New(sha256.New, secret)
	h.Write([]byte(signed))
	return signed + "." + base64.RawURLEncoding.EncodeToString(h.Sum(nil)), nil
}
