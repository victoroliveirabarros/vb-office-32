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

func TestNear(t *testing.T) {
	tests := []struct {
		d2       int
		was      bool
		want     bool
		describe string
	}{
		{0, false, true, "same tile enters"},
		{16, false, true, "4 tiles enters"},
		{16, true, true, "4 tiles stays"},
		{17, false, false, "just past 4 keeps far"},
		{17, true, true, "just past 4 keeps near"},
		{18, false, false, "keeps far"},
		{18, true, true, "keeps near"},
		{20, false, false, "keeps far"},
		{20, true, true, "keeps near"},
		{25, false, false, "5 tiles keeps far"},
		{25, true, true, "5 tiles keeps near"},
		{26, true, false, "past 5 leaves"},
		{26, false, false, "past 5 stays far"},
	}
	for _, tt := range tests {
		if got := near(tt.d2, tt.was); got != tt.want {
			t.Errorf("%s: near(%d, %v) = %v, want %v", tt.describe, tt.d2, tt.was, got, tt.want)
		}
	}
}

// walker steps one player with valid inputs, waiting out the cooldown.
type walker struct {
	t    *testing.T
	s    *Space
	seq  map[string]uint32
	tick int
}

func newWalker(t *testing.T, s *Space) *walker {
	return &walker{t: t, s: s, seq: make(map[string]uint32)}
}

func (w *walker) step(id string, dir Dir) Delta {
	w.t.Helper()
	w.seq[id]++
	enqueue(w.t, w.s, id, w.seq[id], dir)
	w.tick += 3
	return w.s.Step(at(w.tick))
}

func TestProximityHysteresis(t *testing.T) {
	s := NewSpace(asciiMap(t, "0.........1."))
	s.Join("a", "A")
	s.Join("b", "B")
	w := newWalker(t, s)
	if d := s.Step(at(0)); d.Nearby != nil {
		t.Fatalf("nearby = %v, want none at 10 tiles", d.Nearby)
	}

	tests := []struct {
		dir  Dir
		x    int
		want map[string][]string
	}{
		{Left, 9, nil},
		{Left, 8, nil},
		{Left, 7, nil},
		{Left, 6, nil},
		{Left, 5, nil},
		{Left, 4, map[string][]string{"a": {"b"}, "b": {"a"}}},
		{Left, 3, nil},
		{Right, 4, nil},
		{Right, 5, nil},
		{Right, 6, map[string][]string{"a": {}, "b": {}}},
		{Left, 5, nil},
		{Left, 4, map[string][]string{"a": {"b"}, "b": {"a"}}},
	}
	for i, tt := range tests {
		d := w.step("b", tt.dir)
		if got := s.Players()[1].Pos.X; got != tt.x {
			t.Fatalf("step %d: x = %d, want %d", i, got, tt.x)
		}
		if !maps.EqualFunc(d.Nearby, tt.want, slices.Equal) {
			t.Errorf("step %d (x=%d): nearby = %v, want %v", i, tt.x, d.Nearby, tt.want)
		}
	}
}

func TestProximityJoinIsEvaluatedOnNextStep(t *testing.T) {
	s := NewSpace(asciiMap(t, "012"))
	s.Join("a", "A")
	s.Join("b", "B")
	if got := s.Nearby("a"); got == nil || len(got) != 0 {
		t.Errorf("before step: nearby(a) = %#v, want empty", got)
	}

	d := s.Step(at(0))
	want := map[string][]string{"a": {"b"}, "b": {"a"}}
	if !maps.EqualFunc(d.Nearby, want, slices.Equal) {
		t.Errorf("nearby = %v, want %v", d.Nearby, want)
	}

	s.Join("b", "Bob")
	if d := s.Step(at(1)); d.Nearby != nil {
		t.Errorf("after replacement: nearby = %v, want none", d.Nearby)
	}
	if got := s.Nearby("b"); !slices.Equal(got, []string{"a"}) {
		t.Errorf("nearby(b) = %v, want [a]", got)
	}

	s.Join("c", "C")
	d = s.Step(at(2))
	want = map[string][]string{"a": {"b", "c"}, "b": {"a", "c"}, "c": {"a", "b"}}
	if !maps.EqualFunc(d.Nearby, want, slices.Equal) {
		t.Errorf("after c joined: nearby = %v, want %v", d.Nearby, want)
	}
}

func TestProximityLeaveNotifiesNeighbors(t *testing.T) {
	s := NewSpace(asciiMap(t, "012......3"))
	for _, id := range []string{"a", "b", "c", "d"} {
		s.Join(id, id)
	}
	s.Step(at(0))

	s.Leave("b")
	d := s.Step(at(1))
	want := map[string][]string{"a": {"c"}, "c": {"a"}}
	if !maps.EqualFunc(d.Nearby, want, slices.Equal) {
		t.Errorf("nearby = %v, want %v", d.Nearby, want)
	}
	if got := s.Nearby("b"); len(got) != 0 {
		t.Errorf("nearby(b) after leave = %v, want empty", got)
	}

	s.Join("e", "E")
	s.Leave("e")
	if d := s.Step(at(2)); d.Nearby != nil {
		t.Errorf("join and leave before a step: nearby = %v, want none", d.Nearby)
	}

	s.Leave("c")
	s.Join("c", "C")
	d = s.Step(at(3))
	if want := map[string][]string{"c": {"a"}}; !maps.EqualFunc(d.Nearby, want, slices.Equal) {
		t.Errorf("leave and rejoin in place: nearby = %v, want %v (a's set did not change)", d.Nearby, want)
	}
}

func TestProximityIgnoresTurns(t *testing.T) {
	s := NewSpace(asciiMap(t, "01"))
	s.Join("a", "A")
	s.Join("b", "B")
	s.Step(at(0))

	w := newWalker(t, s)
	for _, dir := range []Dir{Up, Left, Down} {
		d := w.step("a", dir)
		if len(d.Moved) != 1 || d.Moved[0].Pos != (tilemap.Point{}) {
			t.Fatalf("%s: moved = %+v, want a turn in place", dir, d.Moved)
		}
		if d.Nearby != nil {
			t.Errorf("%s: nearby = %v, want none", dir, d.Nearby)
		}
	}
}

// TestProximityRandomWalk checks the invariants over many random steps: the
// relation is symmetric, follows the thresholds, and Delta.Nearby lists
// exactly the players whose set changed.
func TestProximityRandomWalk(t *testing.T) {
	row := strings.Repeat(".", 30)
	rows := []string{"0.1.2.3.4.5.6.7.8.9" + strings.Repeat(".", 11)}
	for range 14 {
		rows = append(rows, row)
	}
	s := NewSpace(asciiMap(t, rows...))
	ids := make([]string, 20)
	for i := range ids {
		ids[i] = fmt.Sprintf("p%02d", i)
		s.Join(ids[i], ids[i])
	}
	rng := rand.New(rand.NewPCG(1, 2))
	dirs := []Dir{Up, Down, Left, Right}
	seq := uint32(0)
	prev := map[string][]string{}

	for tick := range 600 {
		seq++
		for _, id := range ids {
			if rng.IntN(3) > 0 {
				enqueue(t, s, id, seq, dirs[rng.IntN(len(dirs))])
			}
		}
		if tick%50 == 0 {
			// A new session starts from an empty set.
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
		for _, id := range ids {
			cur[id] = s.Nearby(id)
			for _, o := range ids {
				if o == id {
					continue
				}
				in := slices.Contains(cur[id], o)
				if in != slices.Contains(s.Nearby(o), id) {
					t.Fatalf("tick %d: %s~%s not symmetric", tick, id, o)
				}
				d2 := dist2(pos[id], pos[o])
				if (d2 <= nearEnter && !in) || (d2 > nearLeave && in) {
					t.Fatalf("tick %d: %s~%s near=%v at d2=%d", tick, id, o, in, d2)
				}
			}
		}
		for _, id := range ids {
			_, reported := d.Nearby[id]
			changed := !slices.Equal(prev[id], cur[id])
			if changed && !reported {
				t.Fatalf("tick %d: %s changed %v -> %v without event", tick, id, prev[id], cur[id])
			}
			if reported && !changed {
				t.Fatalf("tick %d: event for %s without change", tick, id)
			}
			if reported && !slices.Equal(d.Nearby[id], cur[id]) {
				t.Fatalf("tick %d: event %v for %s, want %v", tick, d.Nearby[id], id, cur[id])
			}
		}
		prev = cur
	}
}

func BenchmarkStepProximity200(b *testing.B) {
	rows := make([]string, 25)
	for i := range rows {
		rows[i] = strings.Repeat(".", 40)
	}
	rows[0] = "0" + rows[0][1:]
	s := NewSpace(asciiMap(b, rows...))
	rng := rand.New(rand.NewPCG(1, 2))
	ids := make([]string, 200)
	for i := range ids {
		ids[i] = fmt.Sprintf("p%03d", i)
		s.Join(ids[i], ids[i])
		s.players[ids[i]].Pos = tilemap.Point{X: rng.IntN(40), Y: rng.IntN(25)}
	}
	dirs := []Dir{Up, Down, Left, Right}
	now := t0
	s.Step(now)

	b.ReportAllocs()
	var seq uint32
	for b.Loop() {
		seq++
		for _, id := range ids {
			_ = s.Enqueue(id, Input{Seq: seq, Dir: dirs[rng.IntN(len(dirs))]})
		}
		now = now.Add(StepCooldown)
		s.Step(now)
	}
}
