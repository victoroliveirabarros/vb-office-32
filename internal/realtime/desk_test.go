package realtime

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"slices"
	"strings"
	"testing"
	"testing/synctest"
	"time"

	"github.com/coder/websocket"

	"github.com/victoroliveirabarros/vb-office-32/internal/auth"
	"github.com/victoroliveirabarros/vb-office-32/internal/chat"
	"github.com/victoroliveirabarros/vb-office-32/internal/tilemap"
	"github.com/victoroliveirabarros/vb-office-32/internal/world"
)

// testdata/desks.tmj is an 8x3 map: a walkway on row 0; desks mesa-a
// (x 0..2) and mesa-b (x 3..5) over the chair row 1 and the solid desk row 2;
// spawns at (6,0), (7,0) and (7,2). mesa-a has an owner, Ana; mesa-b is free.
var (
	deskSeat   = tilemap.Point{X: 1, Y: 1}
	mesaA      = zoneMsg{ID: "mesa-a", Name: "Mesa A", Kind: tilemap.Desk}
	deskOwners = map[string]string{"mesa-a": "Ana Souza"}
)

func newDeskRoom(t *testing.T) *Room {
	t.Helper()
	m, err := tilemap.LoadFile("testdata/desks.tmj")
	if err != nil {
		t.Fatal(err)
	}
	room := NewRoom(DefaultSpace, "desks", world.NewSpace(m), nil, slog.New(slog.DiscardHandler))
	room.SetDesks(deskOwners)
	return room
}

// runDeskRoom runs a desk room inside a synctest bubble.
func runDeskRoom(t *testing.T, grace time.Duration) *Room {
	t.Helper()
	room := newDeskRoom(t)
	if grace > 0 {
		room.deskGrace = grace
	}
	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan error)
	go func() { done <- room.Run(ctx) }()
	t.Cleanup(func() {
		cancel()
		if err := <-done; err != nil {
			t.Errorf("run: %v", err)
		}
	})
	return room
}

func joinDesk(t *testing.T, room *Room, name, desk string) *Session {
	t.Helper()
	id := auth.Identity{ID: "guest:" + strings.ToLower(name), Name: name, Desk: desk}
	s := newSession(id, nil, room, sessionLimits{}, slog.New(slog.DiscardHandler))
	if err := room.join(t.Context(), s); err != nil {
		t.Fatal(err)
	}
	return s
}

// inbox drains s.
func inbox(t *testing.T, s *Session) []envelope {
	t.Helper()
	var envs []envelope
	for len(s.out) > 0 {
		envs = append(envs, received(t, s))
	}
	return envs
}

func kinds(envs []envelope) []string {
	ts := make([]string, len(envs))
	for i, e := range envs {
		ts[i] = e.T
	}
	return ts
}

// only checks that envs are of the given types and returns the last raw
// payload of each.
func only(t *testing.T, s *Session, types ...string) map[string]string {
	t.Helper()
	envs := inbox(t, s)
	if got := kinds(envs); !slices.Equal(got, types) {
		t.Fatalf("%s got %v, want %v", s.id, got, types)
	}
	out := make(map[string]string)
	for _, e := range envs {
		out[e.T] = string(e.D)
	}
	return out
}

// posOf finds id in a welcome or state payload.
func posOf(t *testing.T, raw, id string) posMsg {
	t.Helper()
	var v struct {
		Players []posMsg `json:"players"`
	}
	if err := json.Unmarshal([]byte(raw), &v); err != nil {
		t.Fatal(err)
	}
	for _, p := range v.Players {
		if p.ID == id {
			return p
		}
	}
	t.Fatalf("%s not in %s", id, raw)
	return posMsg{}
}

type stepper struct {
	t    *testing.T
	room *Room
	seq  map[string]uint32
}

func newStepper(t *testing.T, room *Room) *stepper {
	return &stepper{t: t, room: room, seq: make(map[string]uint32)}
}

// walk sends one input per step and waits out its cooldown.
func (w *stepper) walk(s *Session, dirs ...world.Dir) {
	w.t.Helper()
	for _, d := range dirs {
		w.seq[s.id]++
		if err := w.room.input(w.t.Context(), s, world.Input{Seq: w.seq[s.id], Dir: d}); err != nil {
			w.t.Fatal(err)
		}
		time.Sleep(world.StepCooldown)
		synctest.Wait()
	}
}

func (w *stepper) request(s *Session, target string, invite bool) {
	w.t.Helper()
	if err := w.room.deskRequest(w.t.Context(), sessionDesk{sess: s, target: target, invite: invite}); err != nil {
		w.t.Fatal(err)
	}
	synctest.Wait()
}

func repeat(d world.Dir, n int) []world.Dir {
	ds := make([]world.Dir, n)
	for i := range ds {
		ds[i] = d
	}
	return ds
}

func TestDeskJoinOrder(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		room := runDeskRoom(t, 0)
		w := newStepper(t, room)
		bob := joinDesk(t, room, "Bob", "")
		synctest.Wait()
		got := only(t, bob, typeWelcome, typeZone, typeDesks, typeNearby, typeChatHistory)
		if want := `{"desks":[{"id":"mesa-a","owner":{"name":"Ana Souza"},"online":false,"locked":true},{"id":"mesa-b","online":false,"locked":false}]}`; got[typeDesks] != want {
			t.Errorf("desks before the owner came = %s, want %s", got[typeDesks], want)
		}

		ana := joinDesk(t, room, "Ana", "mesa-a")
		synctest.Wait()
		got = only(t, ana, typeWelcome, typeZone, typeDesks, typeDeskGuests, typeNearby, typeChatHistory)
		if p := posOf(t, got[typeWelcome], "guest:ana"); p.X != deskSeat.X || p.Y != deskSeat.Y {
			t.Errorf("owner joined at %+v, want the seat %v", p, deskSeat)
		}
		if got[typeZone] != `{"id":"mesa-a","name":"Mesa A","kind":"desk"}` || got[typeDeskGuests] != `{"desk":"mesa-a","guests":[]}` {
			t.Errorf("zone %s, guests %s", got[typeZone], got[typeDeskGuests])
		}
		online := `{"desks":[{"id":"mesa-a","owner":{"id":"guest:ana","name":"Ana"},"online":true,"locked":true},{"id":"mesa-b","online":false,"locked":false}]}`
		if got[typeDesks] != online {
			t.Errorf("desks = %s, want %s", got[typeDesks], online)
		}
		if got := only(t, bob, typeJoined, typeDesks); got[typeDesks] != online {
			t.Errorf("bob's desks = %s, want %s", got[typeDesks], online)
		}

		w.request(ana, bob.id, true)
		if got := only(t, ana, typeDeskGuests); got[typeDeskGuests] != `{"desk":"mesa-a","guests":[{"id":"guest:bob","name":"Bob","online":true}]}` {
			t.Errorf("guests = %s", got[typeDeskGuests])
		}
		invite := `{"desk":"mesa-a","owner":"guest:ana","ownerName":"Ana","invited":true}`
		if got := only(t, bob, typeDeskInvite); got[typeDeskInvite] != invite {
			t.Errorf("invite = %s, want %s", got[typeDeskInvite], invite)
		}

		// A guest that reconnects is still invited, and the owner sees it
		// go and come back.
		room.leave(bob)
		synctest.Wait()
		if got := only(t, ana, typeLeft, typeDeskGuests); !strings.Contains(got[typeDeskGuests], `"online":false`) {
			t.Errorf("guests after bob left = %s", got[typeDeskGuests])
		}
		bob = joinDesk(t, room, "Bob", "")
		synctest.Wait()
		if got := only(t, bob, typeWelcome, typeZone, typeDesks, typeDeskInvite, typeNearby, typeChatHistory); got[typeDeskInvite] != invite {
			t.Errorf("invite on rejoin = %s, want %s", got[typeDeskInvite], invite)
		}
		if got := only(t, ana, typeJoined, typeDeskGuests); !strings.Contains(got[typeDeskGuests], `"online":true`) {
			t.Errorf("guests after bob came back = %s", got[typeDeskGuests])
		}
		w.walk(bob, append(repeat(world.Left, 5), world.Down)...)
		inbox(t, ana)
		if z := inbox(t, bob); !slices.ContainsFunc(z, func(e envelope) bool {
			return e.T == typeZone && string(e.D) == `{"id":"mesa-a","name":"Mesa A","kind":"desk"}`
		}) {
			t.Errorf("reconnected guest did not enter: %v", kinds(z))
		}

		room.leave(ana)
		synctest.Wait()
		if got := only(t, bob, typeLeft, typeDesks); !strings.Contains(got[typeDesks], `"owner":{"id":"guest:ana","name":"Ana Souza"},"online":false`) {
			t.Errorf("desks after the owner left = %s", got[typeDesks])
		}
	})
}

func TestDeskSeat(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		room := runDeskRoom(t, time.Second)
		w := newStepper(t, room)
		joined := func(s *Session) posMsg {
			t.Helper()
			synctest.Wait()
			for _, e := range inbox(t, s) {
				if e.T == typeWelcome {
					return posOf(t, string(e.D), s.id)
				}
			}
			t.Fatalf("%s got no welcome", s.id)
			return posMsg{}
		}
		ana := joinDesk(t, room, "Ana", "mesa-a")
		if p := joined(ana); p.X != 1 || p.Y != 1 {
			t.Fatalf("new owner at %+v, want the seat", p)
		}
		w.walk(ana, world.Up, world.Right)

		again := joinDesk(t, room, "Ana", "mesa-a")
		if p := joined(again); p.X != 2 || p.Y != 0 {
			t.Errorf("replacement at %+v, want {2 0} kept", p)
		}
		room.leave(again)
		time.Sleep(time.Second / 2)
		back := joinDesk(t, room, "Ana", "mesa-a")
		if p := joined(back); p.X != 2 || p.Y != 0 {
			t.Errorf("back within the grace at %+v, want {2 0} kept", p)
		}
		room.leave(back)
		time.Sleep(time.Second + world.TickInterval)
		late := joinDesk(t, room, "Ana", "mesa-a")
		if p := joined(late); p.X != 1 || p.Y != 1 {
			t.Errorf("back after the grace at %+v, want the seat", p)
		}

		// A second identity with the same desk while the owner is online
		// gets neither the desk nor the seat.
		other := joinDesk(t, room, "Ana2", "mesa-a")
		synctest.Wait()
		got := only(t, other, typeWelcome, typeZone, typeDesks, typeNearby, typeChatHistory)
		if p := posOf(t, got[typeWelcome], other.id); p.Y != 0 {
			t.Errorf("second identity at %+v, want a spawn", p)
		}
		if !strings.Contains(got[typeDesks], `"owner":{"id":"guest:ana","name":"Ana"}`) {
			t.Errorf("desks = %s, want Ana still the owner", got[typeDesks])
		}
		inbox(t, late)
		w.request(other, late.id, true)
		if n := len(late.out); n != 0 {
			t.Errorf("invite from a non-owner reached the target: %v", kinds(inbox(t, late)))
		}
	})
}

func TestDeskInviteEnterRevoke(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		room := runDeskRoom(t, 0)
		w := newStepper(t, room)
		ana := joinDesk(t, room, "Ana", "mesa-a")
		bob := joinDesk(t, room, "Bob", "")
		synctest.Wait()
		w.walk(bob, repeat(world.Left, 5)...)
		w.walk(bob, world.Down)
		inbox(t, ana)
		envs := inbox(t, bob)
		last := envs[len(envs)-1]
		if p := posOf(t, string(last.D), bob.id); last.T != typeState || p != (posMsg{ID: bob.id, X: 1, Y: 0, Dir: world.Down}) {
			t.Fatalf("uninvited step down = %s %+v, want turned at {1 0}", last.T, p)
		}

		w.request(ana, bob.id, true)
		only(t, ana, typeDeskGuests)
		only(t, bob, typeDeskInvite)
		w.walk(bob, world.Down)
		got := only(t, bob, typeState, typeZone, typeNearby)
		if got[typeZone] != `{"id":"mesa-a","name":"Mesa A","kind":"desk"}` || got[typeNearby] != `{"ids":["guest:ana"]}` {
			t.Errorf("guest entering: zone %s, nearby %s", got[typeZone], got[typeNearby])
		}
		if got := only(t, ana, typeState, typeNearby); got[typeNearby] != `{"ids":["guest:bob"]}` {
			t.Errorf("owner's nearby = %s", got[typeNearby])
		}

		w.request(ana, bob.id, false)
		if got := only(t, bob, typeDeskInvite); got[typeDeskInvite] != `{"desk":"mesa-a","owner":"guest:ana","ownerName":"Ana","invited":false}` {
			t.Errorf("revocation = %s", got[typeDeskInvite])
		}
		if got := only(t, ana, typeDeskGuests); got[typeDeskGuests] != `{"desk":"mesa-a","guests":[]}` {
			t.Errorf("guests after revocation = %s", got[typeDeskGuests])
		}
		// Out of earshot before the tick that reports the ejection.
		if err := room.chat(t.Context(), sessionChat{sess: ana, cid: "c1", scope: chat.Nearby, text: "só eu"}); err != nil {
			t.Fatal(err)
		}
		synctest.Wait()
		only(t, ana, typeChat)
		if len(bob.out) != 0 {
			t.Errorf("revoked guest got %v", kinds(inbox(t, bob)))
		}
		time.Sleep(world.TickInterval)
		synctest.Wait()
		got = only(t, bob, typeState, typeZone, typeNearby)
		var st stateMsg
		if err := json.Unmarshal([]byte(got[typeState]), &st); err != nil {
			t.Fatal(err)
		}
		if p := posOf(t, got[typeState], bob.id); p.X != 1 || p.Y != 0 || st.Ack != w.seq[bob.id] {
			t.Errorf("ejected to %+v with ack %d, want {1 0} and %d", p, st.Ack, w.seq[bob.id])
		}
		if got[typeZone] != `{"id":""}` || got[typeNearby] != `{"ids":[]}` {
			t.Errorf("after ejection: zone %s, nearby %s", got[typeZone], got[typeNearby])
		}
		if got := only(t, ana, typeState, typeNearby); got[typeNearby] != `{"ids":[]}` {
			t.Errorf("owner's nearby after ejection = %s", got[typeNearby])
		}
		w.walk(bob, world.Down)
		if got := only(t, bob, typeState); strings.Contains(got[typeState], `"y":1`) {
			t.Errorf("revoked guest entered: %s", got[typeState])
		}
	})
}

func TestDeskGrace(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		// Off the ticks, so expiry and a tick never fall on the same instant.
		const grace = time.Second + world.TickInterval/2
		room := runDeskRoom(t, grace)
		w := newStepper(t, room)
		ana := joinDesk(t, room, "Ana", "mesa-a")
		bob := joinDesk(t, room, "Bob", "")
		synctest.Wait()
		w.request(ana, bob.id, true)
		w.walk(bob, append(repeat(world.Left, 5), world.Down)...)
		inbox(t, bob)

		// Back within the grace: the guests stay.
		room.leave(ana)
		time.Sleep(time.Second / 2)
		ana = joinDesk(t, room, "Ana", "mesa-a")
		synctest.Wait()
		if got := only(t, ana, typeWelcome, typeZone, typeDesks, typeDeskGuests, typeNearby, typeChatHistory); !strings.Contains(got[typeDeskGuests], `"id":"guest:bob"`) {
			t.Errorf("guests after coming back = %s", got[typeDeskGuests])
		}
		time.Sleep(time.Second)
		synctest.Wait()
		for _, e := range inbox(t, bob) {
			if e.T == typeDeskInvite || e.T == typeZone {
				t.Errorf("guest got %s %s while the owner was back", e.T, e.D)
			}
		}

		// Gone past the grace: the guests lose the invite and the desk.
		room.leave(ana)
		synctest.Wait()
		only(t, bob, typeLeft, typeDesks)
		time.Sleep(grace)
		synctest.Wait()
		if got := only(t, bob, typeNearby, typeDeskInvite); !strings.Contains(got[typeDeskInvite], `"invited":false`) {
			t.Errorf("at expiry = %s", got[typeDeskInvite])
		}
		time.Sleep(world.TickInterval)
		synctest.Wait()
		got := only(t, bob, typeState, typeZone)
		if p := posOf(t, got[typeState], bob.id); p.X != 1 || p.Y != 0 || got[typeZone] != `{"id":""}` {
			t.Errorf("after expiry at %+v in %s, want {1 0} outside", p, got[typeZone])
		}
		ana = joinDesk(t, room, "Ana", "mesa-a")
		synctest.Wait()
		if got := only(t, ana, typeWelcome, typeZone, typeDesks, typeDeskGuests, typeNearby, typeChatHistory); got[typeDeskGuests] != `{"desk":"mesa-a","guests":[]}` {
			t.Errorf("guests after expiry = %s", got[typeDeskGuests])
		}
	})
}

func TestDeskRequestsIgnored(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		room := runDeskRoom(t, 0)
		w := newStepper(t, room)
		ana := joinDesk(t, room, "Ana", "mesa-a")
		free := joinDesk(t, room, "Bia", "mesa-b")
		synctest.Wait()
		inbox(t, ana)
		if got := kinds(inbox(t, free)); slices.Contains(got, typeDeskGuests) {
			t.Errorf("owner of a free desk got %v", got)
		}

		w.request(free, ana.id, true)
		w.request(ana, "guest:nobody", true)
		w.request(ana, free.id, false)
		if len(ana.out) != 0 || len(free.out) != 0 {
			t.Errorf("ignored requests sent %v and %v", kinds(inbox(t, ana)), kinds(inbox(t, free)))
		}

		w.request(ana, free.id, true)
		inbox(t, ana)
		inbox(t, free)
		w.request(ana, free.id, true)
		if len(ana.out) != 0 || len(free.out) != 0 {
			t.Error("inviting a guest again sent messages")
		}
		room.leave(free)
		synctest.Wait()
		inbox(t, ana)
		w.request(ana, free.id, false)
		if got := only(t, ana, typeDeskGuests); got[typeDeskGuests] != `{"desk":"mesa-a","guests":[]}` {
			t.Errorf("revoking an offline guest = %s", got[typeDeskGuests])
		}
		w.request(ana, free.id, true)
		if len(ana.out) != 0 {
			t.Error("inviting someone offline sent messages")
		}

		guests := make([]*Session, maxGuests+1)
		for i := range guests {
			guests[i] = joinDesk(t, room, fmt.Sprintf("g%02d", i), "")
		}
		synctest.Wait()
		for _, g := range guests {
			inbox(t, g)
			w.request(ana, g.id, true)
		}
		envs := inbox(t, ana)
		var last deskGuestsMsg
		if err := json.Unmarshal(envs[len(envs)-1].D, &last); err != nil {
			t.Fatal(err)
		}
		if len(last.Guests) != maxGuests || len(guests[maxGuests].out) != 0 {
			t.Errorf("%d guests, the one past the cap got %v", len(last.Guests), kinds(inbox(t, guests[maxGuests])))
		}
	})
}

func TestDeskChatNearbyStaysAtDesk(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		room := runDeskRoom(t, 0)
		w := newStepper(t, room)
		ana := joinDesk(t, room, "Ana", "mesa-a")
		bob := joinDesk(t, room, "Bob", "")
		carol := joinDesk(t, room, "Carol", "")
		synctest.Wait()
		w.request(ana, bob.id, true)
		w.walk(bob, append(repeat(world.Left, 4), world.Down)...)
		w.walk(carol, repeat(world.Left, 6)...)
		for _, s := range []*Session{ana, bob, carol} {
			inbox(t, s)
		}

		// carol stands at (1,0), next to ana's seat.
		if err := room.chat(t.Context(), sessionChat{sess: ana, cid: "c1", scope: chat.Nearby, text: "só a mesa"}); err != nil {
			t.Fatal(err)
		}
		synctest.Wait()
		only(t, ana, typeChat)
		if got := only(t, bob, typeChat); !strings.Contains(got[typeChat], "só a mesa") {
			t.Errorf("guest got %s", got[typeChat])
		}
		if len(carol.out) != 0 {
			t.Errorf("carol outside the desk got %v", kinds(inbox(t, carol)))
		}
	})
}

func TestSessionDeskRequest(t *testing.T) {
	room := newDeskRoom(t)
	ana := newSession(auth.Identity{ID: "guest:ana", Name: "Ana", Desk: "mesa-a"}, nil, room, newSessionLimits(), slog.New(slog.DiscardHandler))
	bob := newSession(auth.Identity{ID: "guest:bob", Name: "Bob"}, nil, room, ana.limits, slog.New(slog.DiscardHandler))
	now := time.Now()
	for _, m := range []deskIn{
		{Target: "", invite: true},
		{Target: "guest:ana", invite: true},
		{Target: strings.Repeat("x", maxToLen+1), invite: true},
	} {
		if err := ana.deskRequest(t.Context(), m, now); err != nil {
			t.Fatal(err)
		}
	}
	if err := bob.deskRequest(t.Context(), deskIn{Target: "guest:ana", invite: true}, now); err != nil {
		t.Fatal(err)
	}
	if n := len(room.deskReqs); n != 0 {
		t.Fatalf("%d requests queued, want invalid ones dropped", n)
	}
	for i := range deskBurst + 2 {
		if err := ana.deskRequest(t.Context(), deskIn{Target: "guest:bob", invite: i%2 == 0}, now); err != nil {
			t.Fatal(err)
		}
	}
	if n := len(room.deskReqs); n != deskBurst {
		t.Errorf("%d requests queued, want the burst of %d", n, deskBurst)
	}
	q := <-room.deskReqs
	if q.sess != ana || q.target != "guest:bob" || !q.invite {
		t.Errorf("request = %+v", q)
	}
}

// serveDesks serves testdata/desks.tmj with mesa-a owned by the guest ana.
func serveDesks(t *testing.T) string {
	t.Helper()
	log := slog.New(slog.DiscardHandler)
	return serveRoom(t, newDeskRoom(t), auth.Guest{Desks: map[string]string{"ana": "mesa-a"}}, 10, log)
}

// TestDeskRejectsRawMoves walks a client that ignores the desks straight
// into one: the server never lets it in.
func TestDeskRejectsRawMoves(t *testing.T) {
	url := serveDesks(t)
	ana := dial(t, url, "Ana")
	expect(ana, typeZone, zoneIs(mesaA))
	bob := dial(t, url, "Bob")
	expect[welcomeMsg](bob, typeWelcome, nil)
	dirs := append(repeat(world.Left, 5), world.Down, world.Down, world.Down)
	for i, d := range dirs {
		bob.send(typeMove, moveMsg{Seq: uint32(i + 1), Dir: d})
	}
	for {
		s := expect[stateMsg](bob, typeState, nil)
		for _, p := range s.Players {
			if p.ID == "guest:bob" && p.Y > 0 {
				t.Fatalf("bob entered the desk at %+v", p)
			}
		}
		if s.Ack == uint32(len(dirs)) {
			break
		}
	}
	ana.send(typeDeskInvite, map[string]any{"target": "guest:bob"})
	expect(bob, typeDeskInvite, func(m deskInviteMsg) bool { return m.Invited && m.Desk == "mesa-a" })
	bob.send(typeMove, moveMsg{Seq: uint32(len(dirs) + 1), Dir: world.Down})
	expect(bob, typeZone, zoneIs(mesaA))
}

func TestDeskMessagesPolicy(t *testing.T) {
	url := serveDesks(t)
	for _, msg := range []string{
		`{"t":"deskInvite","d":{"target":5}}`,
		`{"t":"deskRevoke","d":{"target":null,"x":[}}`,
		`{"t":"deskRevoke","d":"guest:bob"}`,
	} {
		c := dial(t, url, "Ana")
		expect[welcomeMsg](c, typeWelcome, nil)
		c.sendRaw(msg)
		c.expectClose(websocket.StatusPolicyViolation)
	}
	c := dial(t, url, "Bob")
	expect[welcomeMsg](c, typeWelcome, nil)
	c.sendRaw(`{"t":"deskInvite","d":{}}`)
	c.sendRaw(`{"t":"deskRevoke","d":{"target":"guest:ana","extra":1}}`)
	c.send(typePing, pingMsg{TS: 1})
	expect[pingMsg](c, typePong, nil)
}

func TestDecodeDeskMessages(t *testing.T) {
	for msg, want := range map[string]deskIn{
		`{"t":"deskInvite","d":{"target":"guest:bob"}}`: {Target: "guest:bob", invite: true},
		`{"t":"deskRevoke","d":{"target":"guest:bob"}}`: {Target: "guest:bob"},
		`{"t":"deskRevoke","d":{}}`:                     {},
	} {
		got, err := decodeClient([]byte(msg))
		if err != nil || got != want {
			t.Errorf("%s = %+v, %v; want %+v", msg, got, err, want)
		}
	}
}
