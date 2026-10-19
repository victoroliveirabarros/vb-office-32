package world

import (
	"fmt"
	"maps"
	"math/rand/v2"
	"slices"
	"strings"
	"testing"

	"github.com/victoroliveirabarros/vb-office-32/internal/tilemap"
)

func TestAudible(t *testing.T) {
	const out = -1
	at := func(x, y, zone int) *player {
		return &player{Player: Player{Pos: tilemap.Point{X: x, Y: y}}, zone: zone}
	}
	tests := []struct {
		name string
		a, b *player
		was  bool
		want bool
	}{
		{"outside within 4", at(0, 0, out), at(4, 0, out), false, true},
		{"outside in the band keeps near", at(0, 0, out), at(4, 2, out), true, true},
		{"outside in the band keeps far", at(0, 0, out), at(4, 2, out), false, false},
		{"outside past 5", at(0, 0, out), at(5, 1, out), true, false},
		{"same zone d2=80", at(0, 0, 0), at(8, 4, 0), false, true},
		{"same zone same tile", at(3, 3, 0), at(3, 3, 0), true, true},
		{"door d2=1 does not hear inside", at(4, 5, out), at(4, 4, 0), false, false},
		{"door d2=1 drops who was near", at(4, 5, out), at(4, 4, 0), true, false},
		{"inside does not hear the door", at(4, 4, 0), at(4, 5, out), true, false},
		{"neighbor zones", at(4, 4, 0), at(5, 4, 1), true, false},
		{"far zones", at(0, 0, 0), at(30, 0, 1), false, false},
	}
	for _, tt := range tests {
		if got := audible(tt.a, tt.b, tt.was); got != tt.want {
			t.Errorf("%s: audible = %v, want %v", tt.name, got, tt.want)
		}
		if got := audible(tt.b, tt.a, tt.was); got != tt.want {
			t.Errorf("%s (swapped): audible = %v, want %v", tt.name, got, tt.want)
		}
	}
}

// roomMap is a 9x5 zone "a" above a wall with doors at x = 1, 4 and 6, and
// spawns below: a at (4,6), b at (5,6), c at (6,6).
func roomMap(t *testing.T) *tilemap.Map {
	return asciiMap(t,
		"aaaaaaaaa",
		"aaaaaaaaa",
		"aaaaaaaaa",
		"aaaaaaaaa",
		"aaaaaaaaa",
		"#.##.#.##",
		"....012..",
	)
}

func TestZoneHearing(t *testing.T) {
	s := NewSpace(roomMap(t))
	for _, id := range []string{"a", "b", "c"} {
		s.Join(id, id)
	}
	if d := s.Step(at(0)); d.Zones != nil {
		t.Fatalf("zones after join = %v, want none", d.Zones)
	}
	w := newWalker(t, s)
	none := map[string]string(nil)
	tests := []struct {
		id     string
		dir    Dir
		zones  map[string]string
		nearby map[string][]string
	}{
		{"a", Up, none, nil},
		{"a", Up, map[string]string{"a": "a"}, map[string][]string{"a": {}, "b": {"c"}, "c": {"b"}}},
		{"b", Left, none, nil},
		{"b", Up, none, nil}, // at the door, d2=1 from a
		{"b", Up, map[string]string{"b": "a"}, map[string][]string{"a": {"b"}, "b": {"a"}, "c": {}}},
		{"b", Right, none, nil},
		{"b", Right, none, nil},
		{"b", Right, none, nil},
		{"b", Right, none, nil}, // (8,4)
		{"a", Left, none, nil},
		{"a", Up, none, nil},
		{"a", Up, none, nil},
		{"a", Up, none, nil},
		{"a", Up, none, nil},
		{"a", Left, none, nil},
		{"a", Left, none, nil},
		{"a", Left, none, nil}, // (0,0), d2=80 from b
		{"a", Left, none, nil}, // turn against the map edge
		{"c", Up, none, nil},
		{"c", Up, map[string]string{"c": "a"}, map[string][]string{"a": {"b", "c"}, "b": {"a", "c"}, "c": {"a", "b"}}},
		{"c", Down, map[string]string{"c": ""}, map[string][]string{"a": {"b"}, "b": {"a"}, "c": {}}},
	}
	for i, tt := range tests {
		d := w.step(tt.id, tt.dir)
		if !maps.Equal(d.Zones, tt.zones) {
			t.Errorf("step %d (%s %s): zones = %v, want %v", i, tt.id, tt.dir, d.Zones, tt.zones)
		}
		if !maps.EqualFunc(d.Nearby, tt.nearby, slices.Equal) {
			t.Errorf("step %d (%s %s): nearby = %v, want %v", i, tt.id, tt.dir, d.Nearby, tt.nearby)
		}
	}
	if z, ok := s.Zone("a"); !ok || z.ID != "a" || z.Name != "Zona a" || z.Kind != tilemap.Meeting {
		t.Errorf("Zone(a) = %+v %v", z, ok)
	}
	if z, ok := s.Zone("c"); ok {
		t.Errorf("Zone(c) = %+v, want none outside", z)
	}
	if z, ok := s.Zone("ghost"); ok {
		t.Errorf("Zone(ghost) = %+v, want none", z)
	}
}

// TestZoneExitNoHysteresis leaves the zone through doors 5 tiles apart: in
// the hysteresis band, but the link came from the zone, so it ends.
func TestZoneExitNoHysteresis(t *testing.T) {
	s := NewSpace(roomMap(t))
	s.Join("a", "a")
	s.Join("b", "b")
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
	if got := s.Nearby("a"); !slices.Equal(got, []string{"b"}) {
		t.Fatalf("nearby(a) in the zone = %v, want [b]", got)
	}

	w.seq["a"]++
	enqueue(t, s, "a", w.seq["a"], Down)
	w.seq["b"]++
	enqueue(t, s, "b", w.seq["b"], Down)
	w.tick += 3
	d := s.Step(at(w.tick))
	if want := map[string]string{"a": "", "b": ""}; !maps.Equal(d.Zones, want) {
		t.Errorf("zones = %v, want %v", d.Zones, want)
	}
	if want := map[string][]string{"a": {}, "b": {}}; !maps.EqualFunc(d.Nearby, want, slices.Equal) {
		t.Errorf("nearby at d2=%d after leaving together = %v, want %v", dist2(pos("a"), pos("b")), d.Nearby, want)
	}
}

func TestZoneReplacementAndRejoin(t *testing.T) {
	s := NewSpace(roomMap(t))
	s.Join("a", "a")
	s.Join("b", "b")
	s.Step(at(0))
	w := newWalker(t, s)
	w.step("a", Up)
	w.step("b", Left)
	if d := w.step("a", Up); !maps.Equal(d.Zones, map[string]string{"a": "a"}) {
		t.Fatalf("zones = %v, want a in a", d.Zones)
	}
	w.step("b", Up)
	w.step("b", Up)

	s.Join("a", "A2")
	if d := s.Step(at(w.tick + 3)); d.Zones != nil || d.Nearby != nil {
		t.Errorf("after replacement: zones = %v, nearby = %v, want none", d.Zones, d.Nearby)
	}

	s.Leave("a")
	if _, ok := s.Zone("a"); ok {
		t.Error("Zone(a) after leave, want none")
	}
	s.Join("a", "a")
	if z, ok := s.Zone("a"); !ok || z.ID != "a" {
		t.Errorf("Zone(a) on rejoin = %+v %v, want a", z, ok)
	}
	d := s.Step(at(w.tick + 6))
	if d.Zones != nil {
		t.Errorf("zones on rejoin = %v, want none: the join reports it", d.Zones)
	}
	if want := map[string][]string{"a": {"b"}}; !maps.EqualFunc(d.Nearby, want, slices.Equal) {
		t.Errorf("nearby on rejoin = %v, want %v (b's set did not change)", d.Nearby, want)
	}
}

// TestProximityRandomWalkZones checks the hearing rule over many random
// steps through zones, some of them side by side.
func TestProximityRandomWalkZones(t *testing.T) {
	rows := []string{"0.1.2.3.4.5.6.7.8.9" + strings.Repeat(".", 11)}
	for y := 1; y < 15; y++ {
		row := []byte(strings.Repeat(".", 30))
		for x := range row {
			switch {
			case x >= 2 && x <= 8 && y >= 3 && y <= 8:
				row[x] = 'a'
			case x >= 12 && x <= 15 && y >= 3 && y <= 12:
				row[x] = 'b'
			case x >= 16 && x <= 19 && y >= 3 && y <= 6:
				row[x] = 'c'
			case x >= 20 && x <= 27 && y >= 10 && y <= 13:
				row[x] = 'd'
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
	rng := rand.New(rand.NewPCG(3, 4))
	dirs := []Dir{Up, Down, Left, Right}
	seq := uint32(0)
	prev := map[string][]string{}
	prevZone := map[string]string{}
	zoneOf := func(id string) string {
		z, _ := s.Zone(id)
		return z.ID
	}
	entered := 0

	for tick := range 2000 {
		seq++
		for _, id := range ids {
			if rng.IntN(3) > 0 {
				enqueue(t, s, id, seq, dirs[rng.IntN(len(dirs))])
			}
		}
		if tick%50 == 0 {
			id := ids[rng.IntN(len(ids))]
			s.Leave(id)
			s.Join(id, id)
			prev[id] = nil
		}
		d := s.Step(at(tick * 3))

		pos := make(map[string]tilemap.Point)
		for _, p := range s.Players() {
			pos[p.ID] = p.Pos
		}
		cur := make(map[string][]string)
		zone := make(map[string]string)
		for _, id := range ids {
			cur[id] = s.Nearby(id)
			zone[id] = zoneOf(id)
			if i := m.ZoneAt(pos[id]); (i < 0) != (zone[id] == "") || i >= 0 && m.Zones[i].ID != zone[id] {
				t.Fatalf("tick %d: %s at %v in zone %q", tick, id, pos[id], zone[id])
			}
			if zone[id] != "" {
				entered++
			}
		}
		for _, id := range ids {
			for _, o := range ids {
				if o == id {
					continue
				}
				in := slices.Contains(cur[id], o)
				if in != slices.Contains(cur[o], id) {
					t.Fatalf("tick %d: %s~%s not symmetric", tick, id, o)
				}
				d2 := dist2(pos[id], pos[o])
				var want bool
				switch {
				case zone[id] != "" || zone[o] != "":
					want = zone[id] == zone[o]
				case d2 <= nearEnter:
					want = true
				case d2 > nearLeave:
					want = false
				default:
					// Hysteresis only from a link made outside zones.
					want = slices.Contains(prev[id], o) && slices.Contains(prev[o], id) &&
						prevZone[id] == "" && prevZone[o] == ""
				}
				if in != want {
					t.Fatalf("tick %d: %s~%s near=%v, want %v (zones %q %q, d2=%d)", tick, id, o, in, want, zone[id], zone[o], d2)
				}
			}
		}
		for _, id := range ids {
			z, reported := d.Zones[id]
			if changed := zone[id] != prevZone[id]; changed != reported || reported && z != zone[id] {
				t.Fatalf("tick %d: %s zone %q -> %q, event %q %v", tick, id, prevZone[id], zone[id], z, reported)
			}
			_, reported = d.Nearby[id]
			changed := !slices.Equal(prev[id], cur[id])
			if changed != reported || reported && !slices.Equal(d.Nearby[id], cur[id]) {
				t.Fatalf("tick %d: %s changed %v -> %v, event %v %v", tick, id, prev[id], cur[id], d.Nearby[id], reported)
			}
		}
		prev, prevZone = cur, zone
	}
	if entered == 0 {
		t.Fatal("nobody ever entered a zone")
	}
}
