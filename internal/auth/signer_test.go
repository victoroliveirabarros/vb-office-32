package auth

import (
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
	s, err := newSigner(testKey, purposeSession)
	if err != nil {
		t.Fatal(err)
	}
	other, err := newSigner(testKey, purposeFlow)
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

	tests := []struct {
		name   string
		signer signer
		token  string
		now    time.Time
	}{
		{"other purpose", other, seal(valid), now},
		{"expired", s, seal(valid), now.Add(time.Minute)},
		{"wrong version", s, seal(testPayload{header: header{V: 2, Exp: valid.Exp}}), now},
		{"no expiry", s, seal(testPayload{header: header{V: tokenVersion}}), now},
		{"too long", s, seal(testPayload{header: valid.header, Data: strings.Repeat("x", maxTokenLen)}), now},
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

func TestSignerKeysDifferByPurpose(t *testing.T) {
	a, _ := newSigner(testKey, purposeSession)
	b, _ := newSigner(testKey, purposeFlow)
	if string(a.key) == string(b.key) || string(a.key) == string(testKey) {
		t.Error("derived keys must differ from each other and from the secret")
	}
}
