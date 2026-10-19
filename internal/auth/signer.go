package auth

import (
	"crypto/hkdf"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"time"
)

const (
	tokenVersion = 2
	maxTokenLen  = 3072

	purposeSession = "vb-office-32 session v1"
	purposeFlow    = "vb-office-32 oidc-flow v1"
)

var (
	errInvalidToken = errors.New("invalid or expired token")
	errTokenTooLong = errors.New("token exceeds size limit")
)

// header is embedded in every signed payload.
type header struct {
	V   int   `json:"v"`
	Exp int64 `json:"exp"`
}

func newHeader(exp time.Time) header {
	return header{V: tokenVersion, Exp: exp.Unix()}
}

func (h header) valid(now time.Time) bool {
	return h.V == tokenVersion && now.Unix() < h.Exp
}

type payload interface {
	valid(now time.Time) bool
}

// signer produces base64url(json).base64url(hmac) tokens with a key derived
// for a single purpose, so a token for one purpose never verifies for another.
// It seals with the first secret's key and opens with any of them, so a
// secret can be rotated without invalidating tokens already issued.
type signer struct {
	keys [][]byte
}

func newSigner(purpose string, secrets ...[]byte) (signer, error) {
	var s signer
	for _, secret := range secrets {
		key, err := hkdf.Key(sha256.New, secret, nil, purpose, sha256.Size)
		if err != nil {
			return signer{}, err
		}
		s.keys = append(s.keys, key)
	}
	if len(s.keys) == 0 {
		return signer{}, errors.New("no signing secret")
	}
	return s, nil
}

func (s signer) seal(p payload) (string, error) {
	b, err := json.Marshal(p)
	if err != nil {
		return "", err
	}
	body := base64.RawURLEncoding.EncodeToString(b)
	token := body + "." + base64.RawURLEncoding.EncodeToString(mac(s.keys[0], body))
	if len(token) > maxTokenLen {
		return "", errTokenTooLong
	}
	return token, nil
}

func (s signer) open(token string, now time.Time, p payload) error {
	if len(token) > maxTokenLen {
		return errInvalidToken
	}
	body, sig, ok := strings.Cut(token, ".")
	if !ok {
		return errInvalidToken
	}
	got, err := base64.RawURLEncoding.DecodeString(sig)
	if err != nil || !slices.ContainsFunc(s.keys, func(key []byte) bool { return hmac.Equal(got, mac(key, body)) }) {
		return errInvalidToken
	}
	b, err := base64.RawURLEncoding.DecodeString(body)
	if err != nil || json.Unmarshal(b, p) != nil || !p.valid(now) {
		return errInvalidToken
	}
	return nil
}

func mac(key []byte, body string) []byte {
	h := hmac.New(sha256.New, key)
	h.Write([]byte(body))
	return h.Sum(nil)
}
