package realtime

import (
	"context"
	"log/slog"
	"slices"
	"testing"
	"testing/synctest"
	"time"

	"github.com/victoroliveirabarros/vb-office-32/internal/auth"
	"github.com/victoroliveirabarros/vb-office-32/internal/chat"
	"github.com/victoroliveirabarros/vb-office-32/internal/tilemap"
	"github.com/victoroliveirabarros/vb-office-32/internal/world"
)

// testdata/room.tmj is a 12x1 open map whose zone sala-1 covers x = 0..4,
// with spawns at x = 5, 6 and 7, all near each other.
var sala = zoneMsg{ID: "sala-1", Name: "Sala 1", Kind: tilemap.Meeting}

func zoneIs(want zoneMsg) func(zoneMsg) bool {
	return func(z zoneMsg) bool { return z == want }
}

// runZoneRoom runs a room on testdata/room.tmj inside a synctest bubble.
func runZoneRoom(t *testing.T, mi Media) *Room {
	t.Helper()
	m, err := tilemap.LoadFile("testdata/room.tmj")
	if err != nil {
		t.Fatal(err)
	}
	room := NewRoom(DefaultSpace, "room", world.NewSpace(m), mi, slog.New(slog.DiscardHandler))
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

// TestZoneMessages checks zone in the join sequence and, on the tick that
// crosses the border, after state and before nearby.
func TestZoneMessages(t *testing.T) {
	for _, tt := range []struct {
		name  string
		media func() Media
		join  []string
	}{
		{"without media", func() Media { return nil }, []string{typeWelcome, typeZone, typeNearby, typeChatHistory}},
		{"with media", func() Media { return &fakeIssuer{ttl: time.Hour} }, []string{typeWelcome, typeMedia, typeZone, typeNearby, typeChatHistory}},
	} {
		t.Run(tt.name, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				room := runZoneRoom(t, tt.media())
				ana := joinAs(t, room, "Ana")
				bob := joinAs(t, room, "Bob")
				synctest.Wait()
				if got := drain(t, ana); !slices.Equal(got, append(slices.Clone(tt.join), typeJoined)) {
					t.Fatalf("ana's join = %v", got)
				}
				if got := drain(t, bob); !slices.Equal(got, tt.join) {
					t.Fatalf("bob's join = %v, want %v", got, tt.join)
				}
				time.Sleep(world.TickInterval)
				synctest.Wait()
				drain(t, ana)
				drain(t, bob)

				move := func(s *Session, seq uint32, dir world.Dir) {
					t.Helper()
					if err := room.input(t.Context(), s, world.Input{Seq: seq, Dir: dir}); err != nil {
						t.Fatal(err)
					}
					time.Sleep(world.TickInterval)
					synctest.Wait()
				}
				zoneOf := func(s *Session, types ...string) zoneMsg {
					t.Helper()
					var z zoneMsg
					var got []string
					for len(s.out) > 0 {
						env := received(t, s)
						got = append(got, env.T)
						if env.T == typeZone {
							z = decode[zoneMsg](t, env)
						}
					}
					if !slices.Equal(got, types) {
						t.Fatalf("%s got %v, want %v", s.id, got, types)
					}
					return z
				}

				move(ana, 1, world.Left)
				if z := zoneOf(ana, typeState, typeZone, typeNearby); z != sala {
					t.Errorf("zone on entering = %+v, want %+v", z, sala)
				}
				zoneOf(bob, typeState, typeNearby)

				time.Sleep(world.StepCooldown)
				move(ana, 2, world.Right)
				if z := zoneOf(ana, typeState, typeZone, typeNearby); z != (zoneMsg{}) {
					t.Errorf("zone on leaving = %+v, want none", z)
				}
				zoneOf(bob, typeState, typeNearby)

				time.Sleep(world.StepCooldown)
				move(ana, 3, world.Left)
				zoneOf(ana, typeState, typeZone, typeNearby)
				zoneOf(bob, typeState, typeNearby)

				// A new connection inside the zone hears of it at join.
				again := joinAs(t, room, "Ana")
				synctest.Wait()
				var got []string
				var z zoneMsg
				for len(again.out) > 0 {
					env := received(t, again)
					got = append(got, env.T)
					if env.T == typeZone {
						z = decode[zoneMsg](t, env)
					}
				}
				if !slices.Equal(got, tt.join) || z != sala {
					t.Errorf("rejoin = %v with zone %+v, want %v with %+v", got, z, tt.join, sala)
				}
			})
		})
	}
}

// TestChatNearbyStaysInZone sends nearby chats from inside a zone with
// someone at the door, one tile away, and from the door.
func TestChatNearbyStaysInZone(t *testing.T) {
	url := serveMap(t, "room", auth.Guest{}, 10, nil, slog.New(slog.DiscardHandler))
	ana := dial(t, url, "Ana")
	expect[welcomeMsg](ana, typeWelcome, nil)
	bob := dial(t, url, "Bob")
	expect[welcomeMsg](bob, typeWelcome, nil)
	carol := dial(t, url, "Carol")
	expect[welcomeMsg](carol, typeWelcome, nil)
	expect(ana, typeNearby, nearbyIs("guest:bob", "guest:carol"))

	ana.send(typeMove, moveMsg{Seq: 1, Dir: world.Left})
	expect(ana, typeZone, zoneIs(sala))
	expect(ana, typeNearby, nearbyIs())
	expect(bob, typeNearby, nearbyIs("guest:carol"))

	// marker sends an everyone chat from c: the next chat each of others
	// reads must be it, so they got nothing before it.
	marker := func(c *client, text string, others ...*client) {
		t.Helper()
		c.chat("marker", chat.Everyone, "", text)
		readChat(c)
		for _, o := range others {
			if got, _ := readChat(o); got.Text != text {
				t.Errorf("received %+v, want only the marker %q", got, text)
			}
		}
	}

	ana.chat("n1", chat.Nearby, "", "da sala")
	if got, _ := readChat(ana); got.CID != "n1" {
		t.Errorf("echo = %+v", got)
	}
	marker(ana, "marco 1", bob, carol)

	for seq := uint32(1); seq <= 3; seq++ {
		carol.send(typeMove, moveMsg{Seq: seq, Dir: world.Left})
	}
	expect(carol, typeZone, zoneIs(sala))
	expect(carol, typeNearby, nearbyIs("guest:ana"))
	expect(bob, typeNearby, nearbyIs())

	ana.chat("n2", chat.Nearby, "", "só a sala")
	readChat(ana)
	if got, _ := readChat(carol); got.Text != "só a sala" || got.Scope != chat.Nearby {
		t.Errorf("carol received %+v, want the nearby chat", got)
	}
	marker(ana, "marco 2", bob, carol)

	bob.chat("n3", chat.Nearby, "", "da porta")
	readChat(bob)
	marker(bob, "marco 3", ana, carol)
}
