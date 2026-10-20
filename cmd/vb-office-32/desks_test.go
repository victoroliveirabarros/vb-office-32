package main

import (
	"context"
	"encoding/json"
	"io"
	"maps"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/coder/websocket"

	"github.com/victoroliveirabarros/vb-office-32/internal/tilemap"
)

func guestEnv(vars map[string]string) map[string]string {
	vars["VB_OFFICE32_AUTH"] = "guest"
	vars["VB_OFFICE32_ADDR"] = "127.0.0.1:8080"
	return vars
}

func TestLoadDesks(t *testing.T) {
	const inline = `{"mesa-01": {"email": "Ana@Example.com", "name": "Ana Souza"}, "mesa-07": {"email": "dani@example.org"}}`
	want := map[string]deskOwner{"mesa-01": {"ana@example.com", "Ana Souza"}, "mesa-07": {"dani@example.org", ""}}
	file := filepath.Join(t.TempDir(), "desks.json")
	if err := os.WriteFile(file, []byte(inline), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, tt := range []struct {
		name string
		vars map[string]string
		src  string
	}{
		{"inline oidc", map[string]string{desksInlineVar: inline}, desksInlineVar},
		{"file oidc", map[string]string{desksFileVar: file}, desksFileVar},
		{"file guest", guestEnv(map[string]string{desksFileVar: file}), desksFileVar},
	} {
		t.Run(tt.name, func(t *testing.T) {
			vars := tt.vars
			if vars["VB_OFFICE32_AUTH"] == "" {
				maps.Copy(vars, oidcEnv())
			}
			cfg, err := loadConfig(env(vars))
			if err != nil {
				t.Fatal(err)
			}
			if !maps.Equal(cfg.desks, want) || cfg.desksVar != tt.src {
				t.Errorf("desks = %v from %s, want %v from %s", cfg.desks, cfg.desksVar, want, tt.src)
			}
		})
	}

	cfg, err := loadConfig(env(map[string]string{"VB_OFFICE32_AUTH": "guest"}))
	if err != nil || cfg.desks != nil {
		t.Errorf("without desks: %v, %v", cfg.desks, err)
	}
	emails, locals, names := ownerMaps(want)
	if !maps.Equal(emails, map[string]string{"ana@example.com": "mesa-01", "dani@example.org": "mesa-07"}) ||
		!maps.Equal(locals, map[string]string{"ana": "mesa-01", "dani": "mesa-07"}) ||
		!maps.Equal(names, map[string]string{"mesa-01": "Ana Souza", "mesa-07": ""}) {
		t.Errorf("ownerMaps = %v %v %v", emails, locals, names)
	}
}

func TestLoadDesksErrors(t *testing.T) {
	const secret = "s3cr3t"
	big := `{"mesa-01": {"email": "ana@example.com", "name": "` + strings.Repeat("a", maxDesksSize) + `"}}`
	tests := []struct {
		name   string
		guest  bool
		addr   string
		desks  string
		reason string
	}{
		{"not an object", false, "", `[]`, "JSON object"},
		{"malformed", false, "", `{"mesa-01": {"email": `, "malformed"},
		{"trailing data", false, "", `{} {}`, "trailing data"},
		{"unknown field", false, "", `{"mesa-01": {"email": "s3cr3t@example.com", "owner": "x"}}`, `desk "mesa-01": want`},
		{"email not a string", false, "", `{"mesa-01": {"email": 1}}`, `desk "mesa-01": want`},
		{"duplicate id", false, "", `{"mesa-01": {"email": "s3cr3t@example.com"}, "mesa-01": {"email": "b@example.com"}}`, "listed twice"},
		{"bad id", false, "", `{"s3cr3t@example.com": {"email": "ana@example.com"}}`, "desk ids must be"},
		{"no email", false, "", `{"mesa-01": {"name": "Ana"}}`, "invalid email"},
		{"display name", false, "", `{"mesa-01": {"email": "Ana <s3cr3t@example.com>"}}`, "invalid email"},
		{"not an address", false, "", `{"mesa-01": {"email": "s3cr3t"}}`, "invalid email"},
		{"non ascii", false, "", `{"mesa-01": {"email": "s3cr3tã@example.com"}}`, "invalid email"},
		{"too long", false, "", `{"mesa-01": {"email": "` + strings.Repeat("s", 250) + `@example.com"}}`, "invalid email"},
		{"repeated email", false, "", `{"mesa-01": {"email": "s3cr3t@example.com"}, "mesa-02": {"email": "S3cr3t@example.com"}}`, `desk "mesa-02": email of another desk`},
		{"domain not allowed", false, "", `{"mesa-01": {"email": "s3cr3t@example.net"}}`, `desk "mesa-01": email domain not in VB_OFFICE32_ALLOWED_DOMAINS`},
		{"empty name", false, "", `{"mesa-01": {"email": "s3cr3t@example.com", "name": ""}}`, "name must have"},
		{"blank name", false, "", `{"mesa-01": {"email": "s3cr3t@example.com", "name": "  "}}`, "name must have"},
		{"long name", false, "", `{"mesa-01": {"email": "s3cr3t@example.com", "name": "` + strings.Repeat("ã", 33) + `"}}`, "name must have"},
		{"control in name", false, "", `{"mesa-01": {"email": "s3cr3t@example.com", "name": "Ana\u0007"}}`, "name must have"},
		{"too big", false, "", big, "larger than 64 KiB"},
		{"guest same local part", true, "localhost:8080", `{"mesa-01": {"email": "s3cr3t@example.com"}, "mesa-02": {"email": "s3cr3t@example.org"}}`, `desk "mesa-02": same email local part`},
		{"guest on every interface", true, ":8080", `{"mesa-01": {"email": "s3cr3t@example.com"}}`, "VB_OFFICE32_ADDR on localhost or 127.0.0.1"},
		{"guest on a public address", true, "10.0.0.1:8080", `{"mesa-01": {"email": "s3cr3t@example.com"}}`, "VB_OFFICE32_ADDR on localhost or 127.0.0.1"},
		{"guest on a lookalike host", true, "localhost.evil.test:8080", `{"mesa-01": {"email": "s3cr3t@example.com"}}`, "VB_OFFICE32_ADDR on localhost or 127.0.0.1"},
		{"guest on any address", true, "0.0.0.0:8080", `{"mesa-01": {"email": "s3cr3t@example.com"}}`, "VB_OFFICE32_ADDR on localhost or 127.0.0.1"},
		{"guest without a port", true, "localhost", `{"mesa-01": {"email": "s3cr3t@example.com"}}`, "VB_OFFICE32_ADDR on localhost or 127.0.0.1"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			vars := oidcEnv()
			if tt.guest {
				vars = map[string]string{"VB_OFFICE32_AUTH": "guest", "VB_OFFICE32_ADDR": tt.addr}
			}
			vars[desksInlineVar] = tt.desks
			_, err := loadConfig(env(vars))
			if err == nil || !strings.Contains(err.Error(), desksInlineVar+": ") || !strings.Contains(err.Error(), tt.reason) {
				t.Fatalf("err = %v, want %s: …%s", err, desksInlineVar, tt.reason)
			}
			if strings.Contains(err.Error(), secret) || strings.Contains(err.Error(), "@") {
				t.Errorf("err = %v echoes an email", err)
			}
		})
	}

	vars := oidcEnv()
	vars[desksInlineVar] = `{}`
	vars[desksFileVar] = "desks.json"
	if _, err := loadConfig(env(vars)); err == nil || !strings.Contains(err.Error(), "set one or the other") {
		t.Errorf("both variables: err = %v", err)
	}
	vars = oidcEnv()
	vars[desksFileVar] = filepath.Join(t.TempDir(), "missing.json")
	if _, err := loadConfig(env(vars)); err == nil || !strings.Contains(err.Error(), desksFileVar+": ") {
		t.Errorf("missing file: err = %v", err)
	}
}

func TestCheckDesks(t *testing.T) {
	m, err := tilemap.LoadFile("../../maps/office.tmj")
	if err != nil {
		t.Fatal(err)
	}
	for id, want := range map[string]string{
		"mesa-12": "",
		"mesa-13": `VB_OFFICE32_DESKS: desk "mesa-13" is not a zone of the map`,
		"privada": `VB_OFFICE32_DESKS: zone "privada" is not a desk`,
	} {
		err := checkDesks(m, config{desksVar: desksInlineVar, desks: map[string]deskOwner{id: {email: "ana@example.com"}}})
		if got := ""; err != nil {
			got = err.Error()
			if got != want {
				t.Errorf("%s: err = %q, want %q", id, got, want)
			}
		} else if want != "" {
			t.Errorf("%s: no error, want %q", id, want)
		}
	}
	vars := guestEnv(map[string]string{desksInlineVar: `{"privada": {"email": "ana@example.com"}}`, "VB_OFFICE32_MAPS_DIR": "../../maps"})
	if err := run(context.Background(), env(vars), io.Discard); err == nil || !strings.Contains(err.Error(), "not a desk") {
		t.Errorf("run with a desk off the map's desks = %v", err)
	}
}

// TestRunWithDesks boots with the example owners in guest mode: ana owns
// mesa-01 and sits at its chair.
func TestRunWithDesks(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	addr, errc := start(t, ctx, map[string]string{"VB_OFFICE32_AUTH": "guest", desksFileVar: "../../docs/desks.example.json"})

	conn, _, err := websocket.Dial(ctx, "ws://"+addr+"/ws?name=Ana", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.CloseNow()
	var welcome struct {
		Players []struct {
			ID   string
			X, Y int
		}
	}
	var desks struct {
		Desks []struct {
			ID     string
			Online bool
			Locked bool
			Owner  *struct{ ID, Name string }
		}
	}
	for _, want := range []string{"welcome", "zone", "desks", "deskGuests"} {
		_, msg, err := conn.Read(ctx)
		if err != nil {
			t.Fatal(err)
		}
		var env struct {
			T string
			D json.RawMessage
		}
		if err := json.Unmarshal(msg, &env); err != nil || env.T != want {
			t.Fatalf("got %s, want %s", msg, want)
		}
		switch env.T {
		case "welcome":
			err = json.Unmarshal(env.D, &welcome)
		case "desks":
			err = json.Unmarshal(env.D, &desks)
		}
		if err != nil {
			t.Fatal(err)
		}
	}
	if p := welcome.Players; len(p) != 1 || p[0].ID != "guest:ana" || p[0].X != 16 || p[0].Y != 13 {
		t.Errorf("welcome players = %+v, want ana at the chair of mesa-01", p)
	}
	locked := map[string]string{}
	for _, d := range desks.Desks {
		if d.Locked {
			locked[d.ID] = d.Owner.Name
		}
	}
	if len(desks.Desks) != 12 || !maps.Equal(locked, map[string]string{"mesa-01": "Ana", "mesa-02": "Bruno Lima", "mesa-07": "Mesa 7"}) {
		t.Errorf("desks = %+v", desks)
	}
	cancel()
	if err := <-errc; err != nil {
		t.Errorf("run: %v", err)
	}
}
