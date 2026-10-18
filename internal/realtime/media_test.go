package realtime

import (
	"encoding/json"
	"fmt"
	"slices"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/victoroliveirabarros/vb-office-32/internal/auth"
	"github.com/victoroliveirabarros/vb-office-32/internal/media"
	"github.com/victoroliveirabarros/vb-office-32/internal/world"
)

type fakeIssuer struct {
	ttl time.Duration
	n   atomic.Int64
}

func (f *fakeIssuer) Issue(identity, name, room string, now time.Time) (media.Grant, error) {
	return media.Grant{
		URL:       "ws://media.test",
		Token:     fmt.Sprintf("%s|%s|%s|%d", identity, name, room, f.n.Add(1)),
		ExpiresAt: now.Add(f.ttl),
	}, nil
}

// next reads the next message, which must be of type typ, into v.
func next[T any](c *client, typ string) T {
	c.t.Helper()
	env, err := c.read()
	if err != nil {
		c.t.Fatalf("waiting for %s: %v", typ, err)
	}
	if env.T != typ {
		c.t.Fatalf("got %s %s, want %s", env.T, env.D, typ)
	}
	var v T
	if err := json.Unmarshal(env.D, &v); err != nil {
		c.t.Fatalf("decode %s: %v", typ, err)
	}
	return v
}

func nearbyIs(ids ...string) func(nearbyMsg) bool {
	return func(m nearbyMsg) bool { return slices.Equal(m.IDs, ids) }
}

func TestMediaAndNearby(t *testing.T) {
	url := serve(t, auth.Guest{}, 10, &fakeIssuer{ttl: time.Hour}, 0)

	before := time.Now()
	ana := dial(t, url, "Ana")
	next[welcomeMsg](ana, typeWelcome)
	m := next[mediaMsg](ana, typeMedia)
	if m.URL != "ws://media.test" || m.Token != "guest:ana|Ana|office|1" {
		t.Errorf("media = %+v", m)
	}
	if exp := time.UnixMilli(m.ExpiresAt); exp.Before(before.Add(time.Hour).Truncate(time.Millisecond)) || exp.After(time.Now().Add(time.Hour)) {
		t.Errorf("expiresAt = %v, want about an hour from now", exp)
	}
	env, err := ana.read()
	if err != nil || env.T != typeNearby || string(env.D) != `{"ids":[]}` {
		t.Fatalf("third message = %s %s (%v), want empty nearby", env.T, env.D, err)
	}

	bob := dial(t, url, "bob")
	next[welcomeMsg](bob, typeWelcome)
	next[mediaMsg](bob, typeMedia)
	if n := next[nearbyMsg](bob, typeNearby); len(n.IDs) != 0 {
		t.Errorf("bob's first nearby = %v, want empty until the next tick", n.IDs)
	}
	expect(bob, typeNearby, nearbyIs("guest:ana"))
	next[playerMsg](ana, typeJoined)
	if n := next[nearbyMsg](ana, typeNearby); !slices.Equal(n.IDs, []string{"guest:bob"}) {
		t.Errorf("ana's nearby = %v, want [guest:bob]", n.IDs)
	}

	again := dial(t, url, "Ana")
	next[welcomeMsg](again, typeWelcome)
	if m := next[mediaMsg](again, typeMedia); m.Token != "guest:ana|Ana|office|3" {
		t.Errorf("media after replace = %+v", m)
	}
	if n := next[nearbyMsg](again, typeNearby); !slices.Equal(n.IDs, []string{"guest:bob"}) {
		t.Errorf("nearby after replace = %v, want [guest:bob]", n.IDs)
	}
	ana.expectClose(statusReplaced)

	again.conn.Close(websocket.StatusNormalClosure, "")
	expect[leftMsg](bob, typeLeft, nil)
	if n := next[nearbyMsg](bob, typeNearby); len(n.IDs) != 0 {
		t.Errorf("bob's nearby after leave = %v, want empty", n.IDs)
	}
}

func TestMediaRenewal(t *testing.T) {
	url := serve(t, auth.Guest{}, 10, &fakeIssuer{ttl: 200 * time.Millisecond}, 10*time.Millisecond)
	c := dial(t, url, "Ana")
	next[welcomeMsg](c, typeWelcome)
	first := next[mediaMsg](c, typeMedia)

	start := time.Now()
	renewed := expect[mediaMsg](c, typeMedia, nil)
	if renewed.Token == first.Token || renewed.ExpiresAt <= first.ExpiresAt {
		t.Errorf("renewed = %+v after %+v, want a newer grant", renewed, first)
	}
	if elapsed := time.Since(start); elapsed > 150*time.Millisecond {
		t.Errorf("renewed after %v, want about halfway through the 200ms grant", elapsed)
	}
}

func TestNoMediaWithoutIssuer(t *testing.T) {
	url := startServer(t)
	ana := dial(t, url, "Ana")
	bob := dial(t, url, "bob")
	expect[welcomeMsg](bob, typeWelcome, nil)

	var seen []string
	read := func(until string, ok func(json.RawMessage) bool) {
		for {
			env, err := ana.read()
			if err != nil {
				t.Fatalf("waiting for %s: %v", until, err)
			}
			seen = append(seen, env.T)
			if env.T == until && ok(env.D) {
				return
			}
		}
	}
	// Two steps a cooldown apart: whatever the tick that saw bob join sent
	// is queued before the second ack.
	ana.send(typeMove, moveMsg{Seq: 1, Dir: world.Right})
	ana.send(typeMove, moveMsg{Seq: 2, Dir: world.Left})
	read(typeState, func(d json.RawMessage) bool {
		var s stateMsg
		return json.Unmarshal(d, &s) == nil && s.Ack == 2
	})
	ana.send(typePing, pingMsg{TS: 1})
	read(typePong, func(json.RawMessage) bool { return true })

	if slices.Contains(seen, typeMedia) || slices.Contains(seen, typeNearby) {
		t.Errorf("messages = %v, want no media or nearby", seen)
	}
}
