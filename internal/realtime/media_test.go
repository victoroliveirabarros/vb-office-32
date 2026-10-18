package realtime

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"slices"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"

	"github.com/coder/websocket"

	"github.com/victoroliveirabarros/vb-office-32/internal/auth"
	"github.com/victoroliveirabarros/vb-office-32/internal/media"
	"github.com/victoroliveirabarros/vb-office-32/internal/tilemap"
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
	url := serve(t, auth.Guest{}, 10, &fakeIssuer{ttl: time.Hour})

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

// TestMediaRenewal runs the room on a fake clock: a 10-minute grant is
// renewed by the first check at or after its halfway point.
func TestMediaRenewal(t *testing.T) {
	m, err := tilemap.LoadFile("testdata/small.tmj")
	if err != nil {
		t.Fatal(err)
	}
	synctest.Test(t, func(t *testing.T) {
		const ttl = 10 * time.Minute
		log := slog.New(slog.DiscardHandler)
		room := NewRoom(DefaultSpace, "small", world.NewSpace(m), &fakeIssuer{ttl: ttl}, log)
		ctx, cancel := context.WithCancel(t.Context())
		done := make(chan error)
		go func() { done <- room.Run(ctx) }()
		defer func() {
			cancel()
			if err := <-done; err != nil {
				t.Errorf("run: %v", err)
			}
		}()

		s := newSession(auth.Identity{ID: "guest:ana", Name: "Ana"}, nil, room, log)
		if err := room.join(ctx, s); err != nil {
			t.Fatal(err)
		}
		synctest.Wait()
		start := time.Now()
		var first mediaMsg
		for _, typ := range []string{typeWelcome, typeMedia, typeNearby} {
			env := received(t, s)
			if env.T != typ {
				t.Fatalf("got %s, want %s", env.T, typ)
			}
			if typ == typeMedia {
				first = decode[mediaMsg](t, env)
			}
		}

		time.Sleep(ttl/2 - time.Nanosecond)
		synctest.Wait()
		if len(s.out) != 0 {
			t.Fatalf("got %s before the halfway point", <-s.out)
		}

		time.Sleep(time.Nanosecond)
		synctest.Wait()
		env := received(t, s)
		if env.T != typeMedia {
			t.Fatalf("got %s at the halfway point, want media", env.T)
		}
		renewed := decode[mediaMsg](t, env)
		if renewed.Token == first.Token || renewed.ExpiresAt != start.Add(ttl/2+ttl).UnixMilli() {
			t.Errorf("renewed = %+v after %+v, want a grant issued at the halfway point", renewed, first)
		}
	})
}

func received(t *testing.T, s *Session) envelope {
	t.Helper()
	select {
	case b := <-s.out:
		var env envelope
		if err := json.Unmarshal(b, &env); err != nil {
			t.Fatalf("decode %s: %v", b, err)
		}
		return env
	default:
		t.Fatal("no message queued")
		return envelope{}
	}
}

func decode[T any](t *testing.T, env envelope) T {
	t.Helper()
	var v T
	if err := json.Unmarshal(env.D, &v); err != nil {
		t.Fatalf("decode %s: %v", env.T, err)
	}
	return v
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
