// Package media issues LiveKit access tokens.
package media

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
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

// Issuer signs LiveKit access tokens with the API key and secret shared with
// the LiveKit server.
type Issuer struct {
	url    string
	key    string
	secret []byte
}

func NewIssuer(url, apiKey, apiSecret string) *Issuer {
	return &Issuer{url: url, key: apiKey, secret: []byte(apiSecret)}
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
func (i *Issuer) Issue(identity, name, room string, now time.Time) (Grant, error) {
	exp := now.Add(TTL)
	token, err := sign(claims{
		Iss:  i.key,
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
	}, i.secret)
	if err != nil {
		return Grant{}, err
	}
	return Grant{URL: i.url, Token: token, ExpiresAt: time.Unix(exp.Unix(), 0)}, nil
}

func sign(c claims, secret []byte) (string, error) {
	b, err := json.Marshal(c)
	if err != nil {
		return "", err
	}
	signed := jwtHeader + "." + base64.RawURLEncoding.EncodeToString(b)
	h := hmac.New(sha256.New, secret)
	h.Write([]byte(signed))
	return signed + "." + base64.RawURLEncoding.EncodeToString(h.Sum(nil)), nil
}
