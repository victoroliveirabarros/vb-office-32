package realtime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
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
	// list answers Participants; nil is an empty room.
	list func(ctx context.Context) ([]string, error)
	// delay is how long Remove takes.
	delay time.Duration

	mu      sync.Mutex
	removed []string
	lists   int
}

func (f *fakeIssuer) Remove(ctx context.Context, room, identity string) (bool, error) {
	select {
	case <-time.After(f.delay):
	case <-ctx.Done():
		return false, ctx.Err()
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.removed = append(f.removed, room+"/"+identity)
	return true, nil
}

func (f *fakeIssuer) Participants(ctx context.Context, _ string) ([]string, error) {
	f.mu.Lock()
	f.lists++
	f.mu.Unlock()
	if f.list == nil {
		return nil, nil
	}
	return f.list(ctx)
}

// removals returns the removals so far, sorted since they run concurrently.
func (f *fakeIssuer) removals() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Sorted(slices.Values(f.removed))
}

func (f *fakeIssuer) listCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.lists
}

// gated returns a list function that waits for gate and then answers ids and
// err.
func gated(gate <-chan struct{}, ids []string, err error) func(context.Context) ([]string, error) {
	return func(ctx context.Context) ([]string, error) {
		select {
		case <-gate:
			return ids, err
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
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
	if err != nil || env.T != typeZone || string(env.D) != `{"id":""}` {
		t.Fatalf("third message = %s %s (%v), want no zone", env.T, env.D, err)
	}
	env, err = ana.read()
	if err != nil || env.T != typeNearby || string(env.D) != `{"ids":[]}` {
		t.Fatalf("fourth message = %s %s (%v), want empty nearby", env.T, env.D, err)
	}
	next[chatHistoryMsg](ana, typeChatHistory)

	bob := dial(t, url, "bob")
	next[welcomeMsg](bob, typeWelcome)
	next[mediaMsg](bob, typeMedia)
	next[zoneMsg](bob, typeZone)
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
	next[zoneMsg](again, typeZone)
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
		for _, typ := range []string{typeWelcome, typeMedia, typeZone, typeNearby, typeChatHistory} {
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

// TestNoMediaWithoutIssuer checks that without media there is no media
// message while nearby still flows, at join and when the set changes.
func TestNoMediaWithoutIssuer(t *testing.T) {
	url := startServer(t)
	ana := dial(t, url, "Ana")
	next[welcomeMsg](ana, typeWelcome)
	if z := next[zoneMsg](ana, typeZone); z != (zoneMsg{}) {
		t.Errorf("zone = %+v, want none", z)
	}
	if n := next[nearbyMsg](ana, typeNearby); n.IDs == nil || len(n.IDs) != 0 {
		t.Errorf("first nearby = %#v, want empty", n.IDs)
	}
	if h := next[chatHistoryMsg](ana, typeChatHistory); h.Messages == nil || len(h.Messages) != 0 {
		t.Errorf("history = %#v, want empty", h.Messages)
	}
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

	if slices.Contains(seen, typeMedia) || !slices.Contains(seen, typeNearby) {
		t.Errorf("messages = %v, want nearby and no media", seen)
	}
}

// runRoom runs a room with fake media inside a synctest bubble and stops it
// when the test ends.
func runRoom(t *testing.T, mi *fakeIssuer) (*Room, context.CancelFunc) {
	t.Helper()
	m, err := tilemap.LoadFile("testdata/small.tmj")
	if err != nil {
		t.Fatal(err)
	}
	room := NewRoom(DefaultSpace, "small", world.NewSpace(m), mi, slog.New(slog.DiscardHandler))
	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan error)
	go func() { done <- room.Run(ctx) }()
	t.Cleanup(func() {
		cancel()
		if err := <-done; err != nil {
			t.Errorf("run: %v", err)
		}
	})
	return room, cancel
}

func joinAs(t *testing.T, room *Room, name string) *Session {
	t.Helper()
	s := newSession(auth.Identity{ID: "guest:" + strings.ToLower(name), Name: name}, nil, room, slog.New(slog.DiscardHandler))
	if err := room.join(t.Context(), s); err != nil {
		t.Fatal(err)
	}
	return s
}

func TestMediaRemovalAfterGrace(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		mi := &fakeIssuer{ttl: time.Hour}
		room, _ := runRoom(t, mi)
		room.leave(joinAs(t, room, "Ana"))

		time.Sleep(removeGrace - time.Nanosecond)
		synctest.Wait()
		if got := mi.removals(); len(got) != 0 {
			t.Fatalf("removed %v before the grace period ended", got)
		}
		time.Sleep(time.Nanosecond)
		synctest.Wait()
		if got := mi.removals(); !slices.Equal(got, []string{"office/guest:ana"}) {
			t.Fatalf("removed %v, want office/guest:ana", got)
		}

		time.Sleep(time.Hour)
		synctest.Wait()
		if got := mi.removals(); len(got) != 1 {
			t.Errorf("removed %v, want a single removal", got)
		}
	})
}

func TestMediaRemovalCanceledByRejoin(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		mi := &fakeIssuer{ttl: time.Hour}
		room, _ := runRoom(t, mi)
		room.leave(joinAs(t, room, "Ana"))
		time.Sleep(removeGrace - time.Second)
		ana := joinAs(t, room, "Ana")

		time.Sleep(time.Hour)
		synctest.Wait()
		if got := mi.removals(); len(got) != 0 {
			t.Fatalf("removed %v after a rejoin within the grace period", got)
		}

		// A new leave starts a new grace period.
		room.leave(ana)
		time.Sleep(removeGrace - time.Nanosecond)
		synctest.Wait()
		if got := mi.removals(); len(got) != 0 {
			t.Fatalf("removed %v before the second grace period ended", got)
		}
		time.Sleep(time.Nanosecond)
		synctest.Wait()
		if got := mi.removals(); !slices.Equal(got, []string{"office/guest:ana"}) {
			t.Errorf("removed %v, want office/guest:ana", got)
		}
	})
}

func TestMediaNotRemovedWhenReplaced(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		mi := &fakeIssuer{ttl: time.Hour}
		room, _ := runRoom(t, mi)
		old := joinAs(t, room, "Ana")
		joinAs(t, room, "Ana")
		room.leave(old)

		time.Sleep(time.Hour)
		synctest.Wait()
		if got := mi.removals(); len(got) != 0 {
			t.Errorf("removed %v while the identity is still connected", got)
		}
	})
}

func TestMediaNotRemovedOnShutdown(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		mi := &fakeIssuer{ttl: time.Hour}
		room, stop := runRoom(t, mi)
		room.leave(joinAs(t, room, "Ana"))
		stop()

		time.Sleep(time.Hour)
		synctest.Wait()
		if got := mi.removals(); len(got) != 0 {
			t.Errorf("removed %v after shutdown", got)
		}
	})
}

func TestReconcileRemovesStale(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		mi := &fakeIssuer{ttl: time.Hour}
		mi.list = func(context.Context) ([]string, error) {
			return []string{"guest:ana", "guest:bob", "guest:mallory", "intruder"}, nil
		}
		room, _ := runRoom(t, mi)
		joinAs(t, room, "Ana")
		bob := joinAs(t, room, "Bob")

		time.Sleep(mediaCheck - removeGrace/2)
		room.leave(bob)
		time.Sleep(removeGrace/2 - time.Nanosecond)
		synctest.Wait()
		if got := mi.removals(); len(got) != 0 {
			t.Fatalf("removed %v before the first check", got)
		}

		time.Sleep(time.Nanosecond)
		synctest.Wait()
		if got, want := mi.removals(), []string{"office/guest:mallory", "office/intruder"}; !slices.Equal(got, want) {
			t.Fatalf("removed %v at the first check, want %v: not the member nor the one in its grace period", got, want)
		}

		time.Sleep(removeGrace / 2)
		synctest.Wait()
		if got, want := mi.removals(), []string{"office/guest:bob", "office/guest:mallory", "office/intruder"}; !slices.Equal(got, want) {
			t.Errorf("removed %v after bob's grace period, want %v", got, want)
		}
	})
}

func TestReconcileOneAtATime(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		gate := make(chan struct{})
		mi := &fakeIssuer{ttl: time.Hour, list: gated(gate, nil, errors.New("connection refused"))}
		runRoom(t, mi)

		time.Sleep(3*mediaCheck + mediaCheck/2)
		synctest.Wait()
		if n := mi.listCount(); n != 1 {
			t.Fatalf("lists = %d while the first is in flight, want 1", n)
		}

		close(gate)
		synctest.Wait()
		time.Sleep(mediaCheck / 2)
		synctest.Wait()
		if n := mi.listCount(); n != 2 {
			t.Errorf("lists = %d after the first failed, want a new one at the next check", n)
		}
	})
}

func TestReconcileDecidesOnCurrentMembers(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		gate := make(chan struct{})
		mi := &fakeIssuer{ttl: time.Hour, list: gated(gate, []string{"guest:ana"}, nil)}
		room, _ := runRoom(t, mi)

		time.Sleep(mediaCheck + time.Second)
		joinAs(t, room, "Ana")
		close(gate)
		synctest.Wait()
		if got := mi.removals(); len(got) != 0 {
			t.Errorf("removed %v, who joined while the list was in flight", got)
		}
	})
}

// TestMediaReissuedAfterRemovalRace rejoins while the removal is in flight:
// the removal may land on the new media connection, so a grant follows it.
func TestMediaReissuedAfterRemovalRace(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		mi := &fakeIssuer{ttl: time.Hour, delay: 2 * time.Second}
		room, _ := runRoom(t, mi)
		room.leave(joinAs(t, room, "Ana"))
		time.Sleep(removeGrace + time.Second)

		ana := joinAs(t, room, "Ana")
		synctest.Wait()
		if got := drain(t, ana); !slices.Equal(got, []string{typeWelcome, typeMedia, typeZone, typeNearby, typeChatHistory}) {
			t.Fatalf("messages on rejoin = %v", got)
		}
		if got := mi.removals(); len(got) != 0 {
			t.Fatalf("removed %v before the call returned", got)
		}

		time.Sleep(time.Second)
		synctest.Wait()
		if got := mi.removals(); !slices.Equal(got, []string{"office/guest:ana"}) {
			t.Fatalf("removed %v, want office/guest:ana", got)
		}
		if got := drain(t, ana); !slices.Equal(got, []string{typeMedia}) {
			t.Errorf("messages after the removal = %v, want a new media grant", got)
		}
	})
}

func drain(t *testing.T, s *Session) []string {
	t.Helper()
	var types []string
	for len(s.out) > 0 {
		types = append(types, received(t, s).T)
	}
	return types
}

type fakeEvents []media.Event

func (f *fakeEvents) ReadEvent(r *http.Request, _ time.Time) (media.Event, error) {
	switch r.Header.Get("Authorization") {
	case "forged":
		return media.Event{}, fmt.Errorf("%w: bad signature", media.ErrUnauthorized)
	case "malformed":
		return media.Event{}, errors.New("webhook: content type")
	}
	ev := (*f)[0]
	*f = (*f)[1:]
	return ev, nil
}

func TestWebhookRemovesParticipantWithoutSession(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		mi := &fakeIssuer{ttl: time.Hour}
		room, _ := runRoom(t, mi)
		joinAs(t, room, "Ana")
		room.leave(joinAs(t, room, "Bob"))
		events := fakeEvents{
			{Event: "participant_joined", Room: "office", Identity: "guest:ana"},
			{Event: "participant_joined", Room: "office", Identity: "guest:bob"},
			{Event: "participant_joined", Room: "office", Identity: "guest:mallory"},
			{Event: "participant_joined", Room: "elsewhere", Identity: "guest:eve"},
			{Event: "track_published", Room: "office", Identity: "guest:eve"},
			{Event: "room_started", Room: "office"},
		}
		h := NewWebhookHandler(NewHub(room), &events, slog.New(slog.DiscardHandler))
		for range len(events) {
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/livekit/webhook", nil))
			if rec.Code != http.StatusOK {
				t.Fatalf("status = %d, want 200", rec.Code)
			}
		}
		synctest.Wait()
		if got := mi.removals(); !slices.Equal(got, []string{"office/guest:mallory"}) {
			t.Errorf("removed %v, want only the active participant without a session", got)
		}
	})
}

func TestWebhookRejected(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		mi := &fakeIssuer{ttl: time.Hour}
		room, _ := runRoom(t, mi)
		h := NewWebhookHandler(NewHub(room), &fakeEvents{}, slog.New(slog.DiscardHandler))
		for auth, want := range map[string]int{"forged": http.StatusUnauthorized, "malformed": http.StatusBadRequest} {
			r := httptest.NewRequest(http.MethodPost, "/livekit/webhook", nil)
			r.Header.Set("Authorization", auth)
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, r)
			if rec.Code != want {
				t.Errorf("%s: status = %d, want %d", auth, rec.Code, want)
			}
		}
		synctest.Wait()
		if got := mi.removals(); len(got) != 0 {
			t.Errorf("removed %v on a rejected webhook", got)
		}
	})
}
