package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"maps"
	"net"
	"net/mail"
	"os"
	"slices"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/victoroliveirabarros/vb-office-32/internal/tilemap"
)

const (
	desksFileVar   = "VB_OFFICE32_DESKS_FILE"
	desksInlineVar = "VB_OFFICE32_DESKS"
	maxDesksSize   = 64 << 10
	maxEmailLen    = 254
	maxDeskName    = 32
	maxDeskIDLen   = 32
)

// deskOwner is a desk's owner as configured: a lowercase email and an
// optional name for the desk's sign while the owner is away.
type deskOwner struct {
	email, name string
}

// loadDesks reads the desk owners from a file or, inline, from the variable
// itself. Errors name the variable and the desk, never an email.
func loadDesks(getenv func(string) string, cfg *config) error {
	file, inline := strings.TrimSpace(getenv(desksFileVar)), strings.TrimSpace(getenv(desksInlineVar))
	var src []byte
	switch {
	case file != "" && inline != "":
		return errors.New(desksFileVar + " and " + desksInlineVar + ": set one or the other")
	case file != "":
		cfg.desksVar = desksFileVar
		f, err := os.Open(file)
		if err != nil {
			return fmt.Errorf("%s: %w", desksFileVar, err)
		}
		defer f.Close()
		if src, err = io.ReadAll(io.LimitReader(f, maxDesksSize+1)); err != nil {
			return fmt.Errorf("%s: %w", desksFileVar, err)
		}
	case inline != "":
		cfg.desksVar = desksInlineVar
		src = []byte(inline)
	default:
		return nil
	}
	if len(src) > maxDesksSize {
		return fmt.Errorf("%s: larger than %d KiB", cfg.desksVar, maxDesksSize>>10)
	}
	desks, err := parseDesks(src)
	if err != nil {
		return fmt.Errorf("%s: %w", cfg.desksVar, err)
	}
	if err := checkOwners(desks, cfg); err != nil {
		return fmt.Errorf("%s: %w", cfg.desksVar, err)
	}
	cfg.desks = desks
	return nil
}

// parseDesks reads {"desk id": {"email": "...", "name": "..."}}.
func parseDesks(src []byte) (map[string]deskOwner, error) {
	dec := json.NewDecoder(bytes.NewReader(src))
	if t, err := dec.Token(); err != nil || t != json.Delim('{') {
		return nil, errors.New("want a JSON object of desk ids to owners")
	}
	desks := make(map[string]deskOwner)
	emails := make(map[string]bool)
	for dec.More() {
		t, err := dec.Token()
		if err != nil {
			return nil, errors.New("malformed JSON")
		}
		id, _ := t.(string)
		if !validDeskID(id) {
			return nil, fmt.Errorf("desk ids must be zone ids of the map, [a-z0-9-]{1,%d}", maxDeskIDLen)
		}
		if _, ok := desks[id]; ok {
			return nil, fmt.Errorf("desk %q: listed twice", id)
		}
		var v struct {
			Email string  `json:"email"`
			Name  *string `json:"name"`
		}
		var raw json.RawMessage
		if err := dec.Decode(&raw); err != nil {
			return nil, fmt.Errorf("desk %q: malformed JSON", id)
		}
		vdec := json.NewDecoder(bytes.NewReader(raw))
		vdec.DisallowUnknownFields()
		if err := vdec.Decode(&v); err != nil {
			return nil, fmt.Errorf(`desk %q: want {"email": "...", "name": "..."} and no other field`, id)
		}
		email, ok := validEmail(v.Email)
		if !ok {
			return nil, fmt.Errorf("desk %q: invalid email", id)
		}
		if emails[email] {
			return nil, fmt.Errorf("desk %q: email of another desk", id)
		}
		emails[email] = true
		o := deskOwner{email: email}
		if v.Name != nil {
			if !validDeskName(*v.Name) {
				return nil, fmt.Errorf("desk %q: name must have 1 to %d characters, no control characters", id, maxDeskName)
			}
			o.name = *v.Name
		}
		desks[id] = o
	}
	if _, err := dec.Token(); err != nil {
		return nil, errors.New("malformed JSON")
	}
	if _, err := dec.Token(); err != io.EOF {
		return nil, errors.New("trailing data after the object")
	}
	return desks, nil
}

// checkOwners holds the owners to the rules of the auth mode: an allowed
// domain with oidc; with guest, where anyone picks any name, distinct
// local parts and a server only this machine reaches.
func checkOwners(desks map[string]deskOwner, cfg *config) error {
	ids := slices.Sorted(maps.Keys(desks))
	switch cfg.auth {
	case authOIDC:
		for _, id := range ids {
			if !slices.Contains(cfg.oidc.AllowedDomains, domain(desks[id].email)) {
				return fmt.Errorf("desk %q: email domain not in VB_OFFICE32_ALLOWED_DOMAINS", id)
			}
		}
	case authGuest:
		if len(ids) > 0 && !loopback(cfg.addr) {
			return errors.New("desk owners in guest mode need VB_OFFICE32_ADDR on localhost or 127.0.0.1, since guests pick their own names (development only)")
		}
		locals := make(map[string]bool)
		for _, id := range ids {
			l := localPart(desks[id].email)
			if locals[l] {
				return fmt.Errorf("desk %q: same email local part as another desk, which guest mode cannot tell apart", id)
			}
			locals[l] = true
		}
	}
	return nil
}

// checkDesks matches the configured desks with the desk zones of m.
func checkDesks(m *tilemap.Map, cfg config) error {
	for id := range cfg.desks {
		switch i := m.ZoneIndex(id); {
		case i < 0:
			return fmt.Errorf("%s: desk %q is not a zone of the map", cfg.desksVar, id)
		case m.Zones[i].Kind != tilemap.Desk:
			return fmt.Errorf("%s: zone %q is not a desk", cfg.desksVar, id)
		}
	}
	return nil
}

// validEmail takes a bare ASCII address and returns it in lowercase.
func validEmail(s string) (string, bool) {
	if s == "" || len(s) > maxEmailLen || !isASCII(s) {
		return "", false
	}
	a, err := mail.ParseAddress(s)
	if err != nil || a.Address != s || a.Name != "" {
		return "", false
	}
	return strings.ToLower(s), true
}

func validDeskName(s string) bool {
	n := utf8.RuneCountInString(s)
	if !utf8.ValidString(s) || n < 1 || n > maxDeskName || strings.TrimSpace(s) == "" {
		return false
	}
	return !strings.ContainsFunc(s, func(r rune) bool { return unicode.IsControl(r) || unicode.Is(unicode.Cf, r) })
}

func validDeskID(id string) bool {
	if id == "" || len(id) > maxDeskIDLen {
		return false
	}
	for _, c := range []byte(id) {
		if !('a' <= c && c <= 'z' || '0' <= c && c <= '9' || c == '-') {
			return false
		}
	}
	return true
}

func isASCII(s string) bool {
	for i := range len(s) {
		if s[i] >= utf8.RuneSelf {
			return false
		}
	}
	return true
}

func domain(email string) string {
	return email[strings.LastIndexByte(email, '@')+1:]
}

func localPart(email string) string {
	return email[:strings.LastIndexByte(email, '@')]
}

// loopback accepts the hosts the code treats as development everywhere
// else, as in validBaseURL.
func loopback(addr string) bool {
	host, _, err := net.SplitHostPort(addr)
	return err == nil && (host == "localhost" || host == "127.0.0.1")
}

// ownerMaps splits the desks into what auth and the room need: emails and
// local parts to desk ids, and desk ids to names.
func ownerMaps(desks map[string]deskOwner) (emails, locals, names map[string]string) {
	emails, locals, names = make(map[string]string), make(map[string]string), make(map[string]string)
	for id, o := range desks {
		emails[o.email] = id
		locals[localPart(o.email)] = id
		names[id] = o.name
	}
	return emails, locals, names
}
