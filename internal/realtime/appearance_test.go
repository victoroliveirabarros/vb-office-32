package realtime

import (
	"encoding/json"
	"errors"
	"maps"
	"slices"
	"testing"
	"testing/synctest"

	"github.com/coder/websocket"

	"github.com/victoroliveirabarros/vb-office-32/internal/avatar"
	"github.com/victoroliveirabarros/vb-office-32/internal/world"
)

// shifted returns a valid look whose shirt is n options after a's.
func shifted(a avatar.Appearance, n int) avatar.Appearance {
	a.Shirt = uint8((int(a.Shirt) + n) % avatar.Count(avatar.Shirt))
	return a
}

var (
	anaLook = avatar.Default("guest:ana")
	bobLook = avatar.Default("guest:bob")
)

func TestDecodeAppearance(t *testing.T) {
	valid := []struct {
		d    string
		want appearanceIn
	}{
		{`{"skin":1,"hair":2,"hairColor":3,"shirt":4,"pants":1,"acc":2}`, appearanceIn{1, 2, 3, 4, 1, 2}},
		{`{}`, appearanceIn{}},
		{`{"shirt":7,"cape":"red","badge":{"x":[1]}}`, appearanceIn{Shirt: 7}},
		{`{"skin":255,"hair":200}`, appearanceIn{Skin: 255, Hair: 200}},
		{`{"skin":null}`, appearanceIn{}},
	}
	for _, tt := range valid {
		msg, err := decodeClient([]byte(`{"t":"appearance","d":` + tt.d + `}`))
		if err != nil {
			t.Errorf("%s: %v", tt.d, err)
			continue
		}
		if msg != tt.want {
			t.Errorf("%s: decoded %+v, want %+v", tt.d, msg, tt.want)
		}
	}

	for _, d := range []string{
		`{"skin":-1}`, `{"skin":1.5}`, `{"skin":1e2}`, `{"skin":256}`,
		`{"skin":"1"}`, `{"hair":true}`, `{"acc":[0]}`, `null`, `[]`, `3`, `"0.0.0"`,
	} {
		if _, err := decodeClient([]byte(`{"t":"appearance","d":` + d + `}`)); !errors.Is(err, errInvalidMessage) {
			t.Errorf("%s: err = %v, want %v", d, err, errInvalidMessage)
		}
	}
	if _, err := decodeClient([]byte(`{"t":"appearance"}`)); !errors.Is(err, errInvalidMessage) {
		t.Errorf("without d: err = %v, want %v", err, errInvalidMessage)
	}
}

func TestPlayerAppearanceKeys(t *testing.T) {
	b, err := encode(typeJoined, newPlayerMsg(world.Player{ID: "guest:ana", Name: "Ana", Dir: world.Down}))
	if err != nil {
		t.Fatal(err)
	}
	var env struct {
		D struct {
			Appearance map[string]json.RawMessage `json:"appearance"`
		} `json:"d"`
	}
	if err := json.Unmarshal(b, &env); err != nil {
		t.Fatal(err)
	}
	want := []string{"acc", "hair", "hairColor", "pants", "shirt", "skin"}
	if got := slices.Sorted(maps.Keys(env.D.Appearance)); !slices.Equal(got, want) {
		t.Errorf("appearance keys = %v in %s, want %v even when zero", got, b, want)
	}
}

func TestAppearanceChanges(t *testing.T) {
	url := startServer(t)
	ana := dial(t, url, "Ana")
	w := expect[welcomeMsg](ana, typeWelcome, nil)
	if len(w.Players) != 1 || w.Players[0].Appearance != anaLook {
		t.Errorf("welcome players = %+v, want ana with the default look %v", w.Players, anaLook)
	}
	bob := dial(t, url, "bob")
	w = expect[welcomeMsg](bob, typeWelcome, nil)
	if i := slices.IndexFunc(w.Players, func(p playerMsg) bool { return p.ID == "guest:ana" }); i < 0 || w.Players[i].Appearance != anaLook {
		t.Errorf("bob welcome players = %+v, want ana with %v", w.Players, anaLook)
	}
	if p := expect[playerMsg](ana, typeJoined, nil); p.Appearance != bobLook {
		t.Errorf("joined = %+v, want bob with the default look %v", p, bobLook)
	}

	first := shifted(anaLook, 1)
	ana.send(typeAppearance, first)
	want := appearanceMsg{ID: "guest:ana", Appearance: first}
	for _, c := range []*client{ana, bob} {
		if got := expect[appearanceMsg](c, typeAppearance, nil); got != want {
			t.Errorf("appearance = %+v, want %+v", got, want)
		}
	}

	ana.send(typeAppearance, first)
	if got := expect[appearanceMsg](ana, typeAppearance, nil); got != want {
		t.Errorf("same look: sender got %+v, want %+v", got, want)
	}
	outside := first
	outside.Hair = uint8(avatar.Count(avatar.Hair))
	ana.send(typeAppearance, outside)
	if got := expect[appearanceMsg](ana, typeAppearance, nil); got != want {
		t.Errorf("look outside the catalog: sender got %+v, want the current %+v", got, want)
	}

	// Messages to bob keep their order, so a broadcast of the two requests
	// above would come before this one.
	second := shifted(anaLook, 2)
	ana.send(typeAppearance, second)
	want.Appearance = second
	if got := expect[appearanceMsg](bob, typeAppearance, nil); got != want {
		t.Errorf("bob got %+v, want only the changes, next %+v", got, want)
	}
	expect(ana, typeAppearance, func(m appearanceMsg) bool { return m == want })

	ana.conn.Close(websocket.StatusNormalClosure, "")
	expect[leftMsg](bob, typeLeft, nil)
	ana = dial(t, url, "Ana")
	w = expect[welcomeMsg](ana, typeWelcome, nil)
	if i := slices.IndexFunc(w.Players, func(p playerMsg) bool { return p.ID == "guest:ana" }); i < 0 || w.Players[i].Appearance != second {
		t.Errorf("after reconnecting: welcome players = %+v, want ana with %v", w.Players, second)
	}
	if p := expect[playerMsg](bob, typeJoined, nil); p.Appearance != second {
		t.Errorf("joined = %+v, want the remembered look %v", p, second)
	}
}

func TestAppearancePolicyViolations(t *testing.T) {
	url := startServer(t)
	for _, d := range []string{`{"skin":-1}`, `{"skin":0.5}`, `{"skin":256}`, `{"skin":"1"}`, `null`} {
		c := dial(t, url, "carol")
		expect[welcomeMsg](c, typeWelcome, nil)
		c.sendRaw(`{"t":"appearance","d":` + d + `}`)
		c.expectClose(websocket.StatusPolicyViolation)
	}
}

func TestAppearanceRateLimit(t *testing.T) {
	url := startServer(t)
	ana := dial(t, url, "Ana")
	expect[welcomeMsg](ana, typeWelcome, nil)

	var last avatar.Appearance
	for i := range appearanceBurst {
		last = shifted(anaLook, i+1)
		ana.send(typeAppearance, last)
		expect(ana, typeAppearance, func(m appearanceMsg) bool { return m.Appearance == last })
	}
	ana.send(typeAppearance, shifted(anaLook, appearanceBurst+1))
	if got := expect[appearanceMsg](ana, typeAppearance, nil); got.Appearance != last {
		t.Errorf("past the burst got %+v, want the current %v", got, last)
	}

	ana.conn.Close(websocket.StatusNormalClosure, "")
	again := dial(t, url, "Ana")
	expect[welcomeMsg](again, typeWelcome, nil)
	again.send(typeAppearance, shifted(anaLook, appearanceBurst+1))
	if got := expect[appearanceMsg](again, typeAppearance, nil); got.Appearance != last {
		t.Errorf("after reconnecting got %+v, want the current %v", got, last)
	}

	bob := dial(t, url, "bob")
	expect[welcomeMsg](bob, typeWelcome, nil)
	look := shifted(bobLook, 1)
	bob.send(typeAppearance, look)
	if got := expect[appearanceMsg](bob, typeAppearance, nil); got.Appearance != look {
		t.Errorf("another identity got %+v, want %v", got, look)
	}
}

func TestAppearanceFromURL(t *testing.T) {
	url := startServer(t)
	bob := dial(t, url, "bob")
	expect[welcomeMsg](bob, typeWelcome, nil)

	look := shifted(anaLook, 3)
	ana := dial(t, url, "Ana&av="+look.String())
	w := expect[welcomeMsg](ana, typeWelcome, nil)
	if i := slices.IndexFunc(w.Players, func(p playerMsg) bool { return p.ID == "guest:ana" }); i < 0 || w.Players[i].Appearance != look {
		t.Errorf("welcome players = %+v, want ana with %v", w.Players, look)
	}
	if p := expect[playerMsg](bob, typeJoined, nil); p.Appearance != look {
		t.Errorf("joined = %+v, want %v", p, look)
	}

	for _, av := range []string{"", "9", "0.0.0.0.0.0.0", "x", "0..1", "-1", "0.0.0.0.0.200"} {
		c := dial(t, url, "Ana&av="+av)
		w := expect[welcomeMsg](c, typeWelcome, nil)
		if i := slices.IndexFunc(w.Players, func(p playerMsg) bool { return p.ID == "guest:ana" }); i < 0 || w.Players[i].Appearance != look {
			t.Errorf("av=%q: welcome players = %+v, want ana keeping %v", av, w.Players, look)
		}
	}

	carol := dial(t, url, "carol&av=bad")
	w = expect[welcomeMsg](carol, typeWelcome, nil)
	if want := avatar.Default("guest:carol"); w.Players[len(w.Players)-1].Appearance != want {
		t.Errorf("invalid av: welcome players = %+v, want carol with the default %v", w.Players, want)
	}
	if p := expect[playerMsg](bob, typeJoined, nil); p.ID != "guest:carol" {
		t.Errorf("joined = %+v, want carol, and no joined for ana's replacements with the same look", p)
	}

	other := shifted(look, 1)
	dial(t, url, "Ana&av="+other.String())
	// The room handles joins in order, so a joined from a replacement with
	// the same look would arrive first.
	if p := expect[playerMsg](bob, typeJoined, nil); p.ID != "guest:ana" || p.Appearance != other {
		t.Errorf("joined = %+v, want ana with %v", p, other)
	}
}

func TestAppearanceAudience(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		room := runLineRoom(t, nil)
		ana := joinAs(t, room, "Ana")
		bob := joinAs(t, room, "Bob")
		synctest.Wait()
		drain(t, ana)
		drain(t, bob)

		send := func(look avatar.Appearance, apply bool) {
			t.Helper()
			if err := room.appearance(t.Context(), sessionAppearance{sess: ana, look: look, apply: apply}); err != nil {
				t.Fatal(err)
			}
			synctest.Wait()
		}
		got := func(s *Session) []appearanceMsg {
			t.Helper()
			var out []appearanceMsg
			for len(s.out) > 0 {
				if env := received(t, s); env.T == typeAppearance {
					out = append(out, decode[appearanceMsg](t, env))
				}
			}
			return out
		}
		look := shifted(anaLook, 1)
		current := []appearanceMsg{{ID: "guest:ana", Appearance: look}}

		send(look, true)
		if a, b := got(ana), got(bob); !slices.Equal(a, current) || !slices.Equal(b, current) {
			t.Errorf("change: ana got %v, bob %v; want both %v", a, b, current)
		}
		send(look, true)
		if a, b := got(ana), got(bob); !slices.Equal(a, current) || len(b) != 0 {
			t.Errorf("same look: ana got %v, bob %v; want only ana %v", a, b, current)
		}
		send(shifted(anaLook, 2), false)
		if a, b := got(ana), got(bob); !slices.Equal(a, current) || len(b) != 0 {
			t.Errorf("not applied: ana got %v, bob %v; want only ana %v", a, b, current)
		}
	})
}
