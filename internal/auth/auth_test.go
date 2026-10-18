package auth

import (
	"errors"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func TestGuest(t *testing.T) {
	tests := []struct {
		name    string
		query   string
		want    Identity
		wantErr bool
	}{
		{name: "simple", query: "Ana", want: Identity{ID: "guest:ana", Name: "Ana"}},
		{name: "trimmed", query: "  Ana Paula ", want: Identity{ID: "guest:ana paula", Name: "Ana Paula"}},
		{name: "symbols", query: "dev_ops-1", want: Identity{ID: "guest:dev_ops-1", Name: "dev_ops-1"}},
		{name: "max length", query: strings.Repeat("a", 24), want: Identity{ID: "guest:" + strings.Repeat("a", 24), Name: strings.Repeat("a", 24)}},
		{name: "empty", query: "", wantErr: true},
		{name: "blank", query: "   ", wantErr: true},
		{name: "too long", query: strings.Repeat("a", 25), wantErr: true},
		{name: "punctuation", query: "ana!", wantErr: true},
		{name: "non ascii", query: "joão", wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r := httptest.NewRequest("GET", "/ws?name="+url.QueryEscape(tt.query), nil)
			got, err := Guest{}.Authenticate(r)
			if tt.wantErr {
				if !errors.Is(err, ErrInvalidName) {
					t.Fatalf("err = %v, want %v", err, ErrInvalidName)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if got != tt.want {
				t.Errorf("identity = %+v, want %+v", got, tt.want)
			}
		})
	}
}
