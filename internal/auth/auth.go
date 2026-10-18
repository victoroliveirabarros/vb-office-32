// Package auth resolves who is connecting.
package auth

import (
	"errors"
	"net/http"
	"strings"
)

var ErrInvalidName = errors.New("name must be 1-24 characters of letters, digits, space, '_' or '-'")

type Identity struct {
	ID   string
	Name string
}

// Guest trusts the "name" query parameter. It is the phase 1 stand-in for SSO.
type Guest struct{}

func (Guest) Authenticate(r *http.Request) (Identity, error) {
	name := strings.TrimSpace(r.URL.Query().Get("name"))
	if !validName(name) {
		return Identity{}, ErrInvalidName
	}
	return Identity{ID: "guest:" + strings.ToLower(name), Name: name}, nil
}

func validName(name string) bool {
	if len(name) == 0 || len(name) > 24 {
		return false
	}
	for _, c := range []byte(name) {
		switch {
		case 'a' <= c && c <= 'z', 'A' <= c && c <= 'Z', '0' <= c && c <= '9':
		case c == ' ', c == '_', c == '-':
		default:
			return false
		}
	}
	return true
}
