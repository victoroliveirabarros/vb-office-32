package world

import (
	"errors"
	"fmt"
	"maps"
	"math/rand/v2"
	"slices"
	"testing"

	"github.com/victoroliveirabarros/vb-office-32/internal/avatar"
	"github.com/victoroliveirabarros/vb-office-32/internal/tilemap"
)

func TestLockedZoneIsSolid(t *testing.T) {
	s := NewSpace(asciiMap(t,
		"0aa",
		"1aa",
	))
	s.Join("a", "A")
	s.Join("b", "B")
	if err := s.Lock("a", "b"); err != nil {
		t.Fatal(err)
	}
	s.Step(at(0))
	w := newWalker(t, s)

	d := w.step("a", Right)
	want := Player{ID: "a", Name: "A", Pos: tilemap.Point{}, Dir: Right, Appearance: avatar.Default("a")}
	if len(d.Moved) != 1 || d.Moved[0] != want || d.Acks["a"] != 1 || d.Zones != nil {
		t.Errorf("into the locked zone: moved %+v, acks %v, zones %v; want a turned in place and acked", d.Moved, d.Acks, d.Zones)
	}
	for _, st := range []struct {
		dir  Dir
		pos  tilemap.Point
		zone map[string]string
	}{
		{Right, tilemap.Point{X: 1, Y: 1}, map[string]string{"b": "a"}},
		{Right, tilemap.Point{X: 2, Y: 1}, nil},
		{Up, tilemap.Point{X: 2}, nil},
		{Left, tilemap.Point{X: 1}, nil},
		{Left, tilemap.Point{}, map[string]string{"b": ""}},
	} {
		d := w.step("b", st.dir)
		if p := s.players["b"]; p.Pos != st.pos || !maps.Equal(d.Zones, st.zone) {
			t.Errorf("b %s: at %v, zones %v; want %v, %v", st.dir, p.Pos, d.Zones, st.pos, st.zone)
		}
	}

	if err := s.Lock("x"); !errors.Is(err, ErrUnknownZone) {
		t.Errorf("Lock(x) = %v, want %v", err, ErrUnknownZone)
	}
}

func TestLockEjects(t *testing.T) {
	s := NewSpace(roomMap(t))
	for _, id := range []string{"a", "b", "c"} {
		s.Join(id, id)
	}
	s.Step(at(0))
	w := newWalker(t, s)
	for _, st := range []struct {
		id  string
		dir Dir
	}{
		{"a", Up}, {"a", Up}, {"a", Left}, {"a", Left}, {"a", Left},
		{"b", Left}, {"b", Up}, {"b", Up}, {"b", Right}, {"b", Right},
	} {
		w.step(st.id, st.dir)
	}
	pos := func(id string) tilemap.Point { return s.players[id].Pos }
	if pos("a") != (tilemap.Point{X: 1, Y: 4}) || pos("b") != (tilemap.Point{X: 6, Y: 4}) {
		t.Fatalf("a at %v, b at %v, want above the doors", pos("a"), pos("b"))
	}
	w.seq["a"]++
	enqueue(t, s, "a", w.seq["a"], Up)
	w.seq["a"]++
	enqueue(t, s, "a", w.seq["a"], Up)

	if err := s.Lock("a"); err != nil {
		t.Fatal(err)
	}
	if pos("a") != (tilemap.Point{X: 1, Y: 5}) || pos("b") != (tilemap.Point{X: 6, Y: 5}) || len(s.players["a"].queue) != 0 {
		t.Fatalf("after Lock: a at %v with %d inputs, b at %v; want both in the doors", pos("a"), len(s.players["a"].queue), pos("b"))
	}
	if _, ok := s.Zone("a"); ok {
		t.Error("Zone(a) after Lock, want none")
	}
	// Out of earshot at once; c, now near b, waits for the Step.
	for _, id := range []string{"a", "b", "c"} {
		if got := s.Nearby(id); len(got) != 0 {
			t.Errorf("nearby(%s) after Lock = %v, want none", id, got)
		}
	}

	w.tick++
	d := s.Step(at(w.tick))
	if len(d.Moved) != 2 || d.Moved[0].ID != "a" || d.Moved[0].Pos != pos("a") || d.Moved[1].ID != "b" {
		t.Errorf("moved = %+v, want a and b in the doors", d.Moved)
	}
	if want := map[string]string{"a": "", "b": ""}; !maps.Equal(d.Zones, want) {
		t.Errorf("zones = %v, want %v", d.Zones, want)
	}
	if want := map[string]uint32{"a": w.seq["a"], "b": w.seq["b"]}; !maps.Equal(d.Acks, want) {
		t.Errorf("acks = %v, want %v", d.Acks, want)
	}
	// a and b land 5 tiles apart: in the band, but the link came from the
	// zone.
	if want := map[string][]string{"a": {}, "b": {"c"}, "c": {"b"}}; !maps.EqualFunc(d.Nearby, want, slices.Equal) {
		t.Errorf("nearby = %v, want %v", d.Nearby, want)
	}

	w.tick += 3
	if d := s.Step(at(w.tick)); d.Moved != nil || d.Acks != nil || d.Zones != nil {
		t.Errorf("next step: %+v, want nothing", d)
	}
	if d := w.step("a", Up); pos("a") != (tilemap.Point{X: 1, Y: 5}) || d.Acks["a"] != w.seq["a"] {
		t.Errorf("a up after Lock: at %v, acks %v; want refused and acked", pos("a"), d.Acks)
	}
}

func TestLockBeforeStepLeaveAndReplace(t *testing.T) {
	s := NewSpace(roomMap(t))
	for _, id := range []string{"a", "b", "c"} {
		s.Join(id, id)
	}
	s.Step(at(0))
	w := newWalker(t, s)
	w.step("a", Up)
	w.step("a", Up)
	w.step("b", Left)
	w.step("b", Up)
	w.step("b", Up)
	if got := s.Nearby("b"); !slices.Equal(got, []string{"a"}) {
		t.Fatalf("nearby(b) in the zone = %v, want [a]", got)
	}
	if err := s.Lock("a"); err != nil {
		t.Fatal(err)
	}
	// Both land in the door, still in earshot.
	if got := s.Nearby("b"); !slices.Equal(got, []string{"a"}) {
		t.Fatalf("nearby(b) after Lock = %v, want [a]", got)
	}
	s.Leave("a")
	s.Join("b", "b")
	w.tick += 3
	d := s.Step(at(w.tick))
	want := Player{ID: "b", Name: "b", Pos: tilemap.Point{X: 4, Y: 5}, Dir: Up, Appearance: avatar.Default("b")}
	if len(d.Moved) != 1 || d.Moved[0] != want || !maps.Equal(d.Zones, map[string]string{"b": ""}) || d.Acks != nil {
		t.Errorf("after leave and replacement: %+v, want b in the door without an ack", d)
	}
	// b's new connection read its set after Lock, less a.
	if want := map[string][]string{"b": {"c"}, "c": {"b"}}; !maps.EqualFunc(d.Nearby, want, slices.Equal) {
		t.Errorf("nearby = %v, want %v", d.Nearby, want)
	}
}

func TestJoinOutOfLockedZone(t *testing.T) {
	s := NewSpace(roomMap(t))
	s.Join("a", "a")
	s.Step(at(0))
	w := newWalker(t, s)
	w.step("a", Up)
	w.step("a", Up)
	w.step("a", Up)
	s.Leave("a")
	s.Lock("a", "b")
	if p := s.Join("a", "a"); p.Pos != (tilemap.Point{X: 4, Y: 5}) {
		t.Errorf("rejoin in a locked zone at %v, want the door", p.Pos)
	}
	if _, ok := s.Zone("a"); ok {
		t.Error("Zone(a) after rejoin, want none")
	}

	s.Lock("a", "a")
	w.step("a", Up)
	s.Leave("a")
	if p := s.Join("a", "a"); p.Pos != (tilemap.Point{X: 4, Y: 4}) {
		t.Errorf("rejoin with access at %v, want the last position", p.Pos)
	}
}

func TestJoinAt(t *testing.T) {
	s := NewSpace(roomMap(t))
	seat, ok := s.Seat("a")
	if !ok || seat != (tilemap.Point{X: 4, Y: 2}) {
		t.Fatalf("Seat(a) = %v %v, want {4 2}", seat, ok)
	}
	if _, ok := s.Seat("x"); ok {
		t.Error("Seat(x) found")
	}
	if zs := s.Zones(); len(zs) != 1 || zs[0].ID != "a" {
		t.Errorf("Zones() = %+v", zs)
	}

	s.Lock("a", "a")
	if p := s.JoinAt("a", "a", seat); p.Pos != seat {
		t.Errorf("JoinAt = %v, want the seat", p.Pos)
	}
	if z, ok := s.Zone("a"); !ok || z.ID != "a" {
		t.Errorf("Zone(a) = %+v %v, want a", z, ok)
	}
	if p := s.JoinAt("a", "a2", tilemap.Point{}); p.Pos != seat || p.Name != "a2" {
		t.Errorf("replacement JoinAt = %+v, want the seat kept", p)
	}
	if p := s.JoinAt("b", "b", seat); p.Pos != (tilemap.Point{X: 4, Y: 5}) {
		t.Errorf("JoinAt into a zone b may not enter = %v, want the door", p.Pos)
	}
	if p := s.Join("c", "c"); p.Pos != (tilemap.Point{X: 4, Y: 6}) {
		t.Errorf("Join after JoinAt = %v, want the first spawn", p.Pos)
	}

	look := otherLook(avatar.Default("a"))
	s.SetAppearance("a", look)
	s.Leave("a")
	if p := s.JoinAt("a", "a", tilemap.Point{X: 8, Y: 6}); p.Pos != (tilemap.Point{X: 8, Y: 6}) || p.Appearance != look {
		t.Errorf("returning JoinAt = %+v, want at {8 6} with the last look", p)
	}
}

// TestLockedRandomWalk walks players at random while the zones' guests
// change, and checks nobody ever stands where they may not.
func TestLockedRandomWalk(t *testing.T) {
	rows := []string{"0.1.2.3.4.5.6.7.8.9" + "..........."}
	for y := 1; y < 12; y++ {
		row := []byte("..............................")
		for x := range row {
			switch {
			case x >= 2 && x <= 8 && y >= 3 && y <= 8:
				row[x] = 'a'
			case x >= 12 && x <= 14 && y >= 3 && y <= 4:
				row[x] = 'b'
			case x >= 15 && x <= 17 && y >= 3 && y <= 4:
				row[x] = 'c'
			}
		}
		rows = append(rows, string(row))
	}
	m := asciiMap(t, rows...)
	s := NewSpace(m)
	ids := make([]string, 20)
	for i := range ids {
		ids[i] = fmt.Sprintf("p%02d", i)
		s.Join(ids[i], ids[i])
	}
	rng := rand.New(rand.NewPCG(5, 6))
	access := map[string][]string{}
	lock := func() {
		for _, z := range []string{"b", "c"} {
			var guests []string
			for _, id := range ids {
				if rng.IntN(3) == 0 {
					guests = append(guests, id)
				}
			}
			access[z] = guests
			if err := s.Lock(z, guests...); err != nil {
				t.Fatal(err)
			}
		}
	}
	lock()
	dirs := []Dir{Up, Down, Left, Right}
	seq := uint32(0)
	prevZone := map[string]string{}
	entered := 0
	for tick := range 3000 {
		seq++
		for _, id := range ids {
			if rng.IntN(3) > 0 {
				_ = s.Enqueue(id, Input{Seq: seq, Dir: dirs[rng.IntN(len(dirs))]})
			}
		}
		if tick%40 == 0 {
			lock()
		}
		if tick%70 == 0 {
			id := ids[rng.IntN(len(ids))]
			s.Leave(id)
			s.Join(id, id)
			z, _ := s.Zone(id)
			prevZone[id] = z.ID
		}
		d := s.Step(at(tick * 3))
		for _, id := range ids {
			z, _ := s.Zone(id)
			if g, locked := access[z.ID]; locked {
				if !slices.Contains(g, id) {
					t.Fatalf("tick %d: %s in locked zone %q", tick, id, z.ID)
				}
				entered++
			}
			ev, reported := d.Zones[id]
			if changed := z.ID != prevZone[id]; changed != reported || reported && ev != z.ID {
				t.Fatalf("tick %d: %s zone %q -> %q, event %q %v", tick, id, prevZone[id], z.ID, ev, reported)
			}
			prevZone[id] = z.ID
		}
	}
	if entered == 0 {
		t.Fatal("nobody ever entered a locked zone")
	}
}
