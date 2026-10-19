package auth

import (
	"errors"
	"strings"
	"testing"
	"time"
)

type testPayload struct {
	header
	Data string `json:"data"`
}

func TestSigner(t *testing.T) {
	now := time.Unix(1_000_000, 0)
	s, err := newSigner(purposeSession, testKey)
	if err != nil {
		t.Fatal(err)
	}
	other, err := newSigner(purposeFlow, testKey)
	if err != nil {
		t.Fatal(err)
	}
	seal := func(p testPayload) string {
		token, err := s.seal(&p)
		if err != nil {
			t.Fatal(err)
		}
		return token
	}
	valid := testPayload{header: newHeader(now.Add(time.Minute)), Data: "x"}

	var got testPayload
	if err := s.open(seal(valid), now, &got); err != nil || got != valid {
		t.Fatalf("round trip = %+v, %v", got, err)
	}

	if _, err := s.seal(&testPayload{header: valid.header, Data: strings.Repeat("x", maxTokenLen)}); !errors.Is(err, errTokenTooLong) {
		t.Errorf("seal of oversized payload = %v, want errTokenTooLong", err)
	}
	long := strings.Repeat("A", maxTokenLen)
	long += "." + b64(mac(s.keys[0], long))

	tests := []struct {
		name   string
		signer signer
		token  string
		now    time.Time
	}{
		{"other purpose", other, seal(valid), now},
		{"expired", s, seal(valid), now.Add(time.Minute)},
		{"previous version", s, seal(testPayload{header: header{V: 1, Exp: valid.Exp}}), now},
		{"next version", s, seal(testPayload{header: header{V: 3, Exp: valid.Exp}}), now},
		{"no expiry", s, seal(testPayload{header: header{V: tokenVersion}}), now},
		{"too long", s, long, now},
		{"empty", s, "", now},
		{"bad base64", s, "!!.!!", now},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if err := tt.signer.open(tt.token, tt.now, &testPayload{}); err == nil {
				t.Error("open succeeded, want error")
			}
		})
	}
}

func TestSignerRotation(t *testing.T) {
	now := time.Unix(1_000_000, 0)
	p := testPayload{header: newHeader(now.Add(time.Minute)), Data: "x"}
	old, _ := newSigner(purposeSession, testKey)
	current, _ := newSigner(purposeSession, newKey)
	rotated, err := newSigner(purposeSession, newKey, testKey)
	if err != nil {
		t.Fatal(err)
	}
	oldToken, _ := old.seal(&p)
	if err := rotated.open(oldToken, now, &testPayload{}); err != nil {
		t.Errorf("token of the previous key: %v, want accepted", err)
	}
	token, _ := rotated.seal(&p)
	if err := current.open(token, now, &testPayload{}); err != nil {
		t.Errorf("rotated signer did not seal with the current key: %v", err)
	}
	if err := old.open(token, now, &testPayload{}); err == nil {
		t.Error("rotated signer sealed with the previous key")
	}
	if _, err := newSigner(purposeSession); err == nil {
		t.Error("newSigner without secrets succeeded")
	}
}

func TestSignerKeysDifferByPurpose(t *testing.T) {
	a, _ := newSigner(purposeSession, testKey)
	b, _ := newSigner(purposeFlow, testKey)
	if string(a.keys[0]) == string(b.keys[0]) || string(a.keys[0]) == string(testKey) {
		t.Error("derived keys must differ from each other and from the secret")
	}
}
