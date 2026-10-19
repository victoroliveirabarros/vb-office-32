package world

import (
	"encoding/json"
	"errors"
	"maps"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/victoroliveirabarros/vb-office-32/internal/tilemap"
)

// asciiMap builds a map where '#' is a wall, digits are spawn points,
// ordered by digit, and each lowercase letter is a zone with that id
// covering the bounding box of its tiles.
func asciiMap(t testing.TB, rows ...string) *tilemap.Map {
	t.Helper()
	w, h := len(rows[0]), len(rows)
	walls := make([]int, 0, w*h)
	spawns := make([]map[string]any, 10)
	boxes := make(map[rune][4]int)
	for y, row := range rows {
		for x, c := range row {
			gid := 0
			switch {
			case c == '#':
				gid = 3
			case c >= '0' && c <= '9':
				spawns[c-'0'] = map[string]any{"point": true, "x": x*32 + 16, "y": y*32 + 16}
			case c >= 'a' && c <= 'z':
				b, ok := boxes[c]
				if !ok {
					b = [4]int{x, y, x, y}
				}
				boxes[c] = [4]int{min(b[0], x), min(b[1], y), max(b[2], x), max(b[3], y)}
			}
			walls = append(walls, gid)
		}
	}
	var objects []map[string]any
	for _, s := range spawns {
		if s != nil {
			objects = append(objects, s)
		}
	}
	var zones []map[string]any
	for _, c := range slices.Sorted(maps.Keys(boxes)) {
		b := boxes[c]
		zones = append(zones, map[string]any{
			"name": "Zona " + string(c),
			"x":    b[0] * 32, "y": b[1] * 32, "width": (b[2] - b[0] + 1) * 32, "height": (b[3] - b[1] + 1) * 32,
			"properties": []any{
				map[string]any{"name": "id", "type": "string", "value": string(c)},
				map[string]any{"name": "kind", "type": "string", "value": "meeting"},
			},
		})
	}
	b, err := json.Marshal(map[string]any{
		"orientation": "orthogonal",
		"width":       w,
		"height":      h,
		"tilewidth":   32,
		"tileheight":  32,
		"layers": []any{
			map[string]any{"name": "floor", "type": "tilelayer", "width": w, "height": h, "data": make([]int, w*h)},
			map[string]any{"name": "walls", "type": "tilelayer", "width": w, "height": h, "data": walls},
			map[string]any{"name": "spawns", "type": "objectgroup", "objects": objects},
			map[string]any{"name": "zones", "type": "objectgroup", "objects": zones},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	m, err := tilemap.Load(strings.NewReader(string(b)))
	if err != nil {
		t.Fatal(err)
	}
	return m
}

func enqueue(t *testing.T, s *Space, id string, seq uint32, dir Dir) {
	t.Helper()
	if err := s.Enqueue(id, Input{Seq: seq, Dir: dir}); err != nil {
		t.Fatal(err)
	}
}

var t0 = time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)

func at(ticks int) time.Time { return t0.Add(time.Duration(ticks) * TickInterval) }

func TestStepMovement(t *testing.T) {
	m := asciiMap(t,
		"0.#",
		"...",
	)
	tests := []struct {
		name    string
		dir     Dir
		wantPos tilemap.Point
	}{
		{"free step", Right, tilemap.Point{X: 1}},
		{"free step down", Down, tilemap.Point{Y: 1}},
		{"map edge up", Up, tilemap.Point{}},
		{"map edge left", Left, tilemap.Point{}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s := NewSpace(m)
			s.Join("a", "A")
			enqueue(t, s, "a", 1, tt.dir)
			d := s.Step(at(0))

			want := Player{ID: "a", Name: "A", Pos: tt.wantPos, Dir: tt.dir}
			if got := s.Players()[0]; got != want {
				t.Errorf("player = %+v, want %+v", got, want)
			}
			if d.Acks["a"] != 1 {
				t.Errorf("ack = %d, want 1", d.Acks["a"])
			}
			changed := tt.dir != Down || tt.wantPos != (tilemap.Point{})
			if got := len(d.Moved) == 1; got != changed {
				t.Errorf("moved = %v, want changed=%v", d.Moved, changed)
			}
		})
	}
}

func TestStepWallTurnsAndAcks(t *testing.T) {
	s := NewSpace(asciiMap(t, ".0#"))
	s.Join("a", "A")
	enqueue(t, s, "a", 7, Right)
	d := s.Step(at(0))

	want := Player{ID: "a", Name: "A", Pos: tilemap.Point{X: 1}, Dir: Right}
	if len(d.Moved) != 1 || d.Moved[0] != want {
		t.Errorf("moved = %+v, want [%+v]", d.Moved, want)
	}
	if d.Acks["a"] != 7 {
		t.Errorf("ack = %d, want 7", d.Acks["a"])
	}

	enqueue(t, s, "a", 8, Right)
	d = s.Step(at(3))
	if len(d.Moved) != 0 {
		t.Errorf("moved = %+v, want none when facing the wall already", d.Moved)
	}
	if d.Acks["a"] != 8 {
		t.Errorf("ack = %d, want 8", d.Acks["a"])
	}
}

func TestStepCooldown(t *testing.T) {
	s := NewSpace(asciiMap(t, "0...."))
	s.Join("a", "A")
	for seq := uint32(1); seq <= 3; seq++ {
		enqueue(t, s, "a", seq, Right)
	}

	wantX := []int{1, 1, 1, 2, 2, 2, 3, 3}
	for tick, x := range wantX {
		s.Step(at(tick))
		if got := s.Players()[0].Pos.X; got != x {
			t.Fatalf("tick %d: x = %d, want %d", tick, got, x)
		}
	}
}

func TestStepCooldownToleratesEarlyTick(t *testing.T) {
	s := NewSpace(asciiMap(t, "0...."))
	s.Join("a", "A")
	enqueue(t, s, "a", 1, Right)
	enqueue(t, s, "a", 2, Right)

	s.Step(t0)
	s.Step(t0.Add(StepCooldown - time.Millisecond))
	if got := s.Players()[0].Pos.X; got != 2 {
		t.Errorf("x = %d, want 2", got)
	}
}

func TestStepCadence(t *testing.T) {
	ms := func(vs ...int) []time.Duration {
		ds := make([]time.Duration, len(vs))
		for i, v := range vs {
			ds[i] = time.Duration(v) * time.Millisecond
		}
		return ds
	}
	tests := []struct {
		name     string
		arrivals []time.Duration // each input is enqueued before the first tick at or after it
		ticks    []time.Duration
		want     []time.Duration // ticks that consumed an input
	}{
		{
			name:     "on time",
			arrivals: ms(0, 0, 0),
			ticks:    ms(0, 50, 100, 150, 200, 250, 300),
			want:     ms(0, 150, 300),
		},
		{
			name:     "tick 30ms late",
			arrivals: ms(0, 0, 0),
			ticks:    ms(0, 50, 100, 180, 200, 250, 300),
			want:     ms(0, 180, 300),
		},
		{
			name:     "tick 45ms late",
			arrivals: ms(0, 0, 0),
			ticks:    ms(0, 50, 100, 195, 200, 250, 300),
			want:     ms(0, 195, 300),
		},
		{
			name:     "consecutive late ticks",
			arrivals: ms(0, 0, 0, 0),
			ticks:    ms(0, 50, 100, 180, 200, 250, 340, 350, 400, 450),
			want:     ms(0, 180, 340, 450),
		},
		{
			name:     "idle restarts cadence",
			arrivals: ms(0, 160, 160),
			ticks:    ms(0, 50, 100, 150, 200, 250, 300, 350, 400),
			want:     ms(0, 200, 350),
		},
		{
			name:     "stall does not burst",
			arrivals: ms(0, 0, 0, 0),
			ticks:    ms(0, 1000, 1050, 1100, 1150, 1200, 1250),
			want:     ms(0, 1000, 1100, 1250),
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s := NewSpace(asciiMap(t, "0.........."))
			s.Join("a", "A")
			var seq uint32
			var got []time.Duration
			for _, tick := range tt.ticks {
				for int(seq) < len(tt.arrivals) && tt.arrivals[seq] <= tick {
					seq++
					enqueue(t, s, "a", seq, Right)
				}
				if d := s.Step(t0.Add(tick)); len(d.Acks) > 0 {
					got = append(got, tick)
				}
			}
			if !slices.Equal(got, tt.want) {
				t.Errorf("steps at %v, want %v", got, tt.want)
			}
		})
	}
}

func TestEnqueue(t *testing.T) {
	s := NewSpace(asciiMap(t, "0."))
	s.Join("a", "A")

	if err := s.Enqueue("ghost", Input{Seq: 1, Dir: Up}); !errors.Is(err, ErrUnknownPlayer) {
		t.Errorf("unknown player: err = %v, want %v", err, ErrUnknownPlayer)
	}
	if err := s.Enqueue("a", Input{Seq: 0, Dir: Up}); !errors.Is(err, ErrStaleSeq) {
		t.Errorf("seq 0: err = %v, want %v", err, ErrStaleSeq)
	}
	for seq := uint32(1); seq <= MaxPendingInputs; seq++ {
		if err := s.Enqueue("a", Input{Seq: seq, Dir: Up}); err != nil {
			t.Fatalf("seq %d: %v", seq, err)
		}
	}
	if err := s.Enqueue("a", Input{Seq: MaxPendingInputs + 1, Dir: Up}); !errors.Is(err, ErrQueueFull) {
		t.Errorf("over cap: err = %v, want %v", err, ErrQueueFull)
	}
	if err := s.Enqueue("a", Input{Seq: 3, Dir: Up}); !errors.Is(err, ErrStaleSeq) {
		t.Errorf("old seq: err = %v, want %v", err, ErrStaleSeq)
	}

	s.Step(at(0))
	if err := s.Enqueue("a", Input{Seq: 1, Dir: Up}); !errors.Is(err, ErrStaleSeq) {
		t.Errorf("acked seq: err = %v, want %v", err, ErrStaleSeq)
	}
}

func TestJoinSpawnCycles(t *testing.T) {
	s := NewSpace(asciiMap(t, "1.0"))
	want := []tilemap.Point{{X: 2}, {X: 0}, {X: 2}}
	for i, id := range []string{"a", "b", "c"} {
		if got := s.Join(id, id).Pos; got != want[i] {
			t.Errorf("join %s: pos = %v, want %v", id, got, want[i])
		}
	}
}

func TestReconnectRestoresPosition(t *testing.T) {
	s := NewSpace(asciiMap(t, "0..."))
	s.Join("a", "A")
	enqueue(t, s, "a", 1, Right)
	s.Step(at(0))
	s.Leave("a")

	if got := len(s.Players()); got != 0 {
		t.Fatalf("players after leave = %d, want 0", got)
	}
	s.Join("b", "B")

	want := Player{ID: "a", Name: "A", Pos: tilemap.Point{X: 1}, Dir: Right}
	if got := s.Join("a", "A"); got != want {
		t.Errorf("rejoin = %+v, want %+v", got, want)
	}
}

func TestJoinWhilePresentResetsInputs(t *testing.T) {
	s := NewSpace(asciiMap(t, "0..."))
	s.Join("a", "A")
	enqueue(t, s, "a", 5, Right)
	enqueue(t, s, "a", 6, Right)

	s.Join("a", "A")
	if d := s.Step(at(0)); len(d.Acks) != 0 {
		t.Errorf("acks = %v, want queue cleared", d.Acks)
	}
	if err := s.Enqueue("a", Input{Seq: 1, Dir: Right}); err != nil {
		t.Errorf("new connection seq 1: %v", err)
	}
}

func TestStepPlayersDoNotCollide(t *testing.T) {
	s := NewSpace(asciiMap(t, "01"))
	s.Join("a", "A")
	s.Join("b", "B")
	enqueue(t, s, "a", 1, Right)

	d := s.Step(at(0))
	if len(d.Moved) != 1 || d.Moved[0].Pos != (tilemap.Point{X: 1}) {
		t.Errorf("moved = %+v, want a on b's tile", d.Moved)
	}
	if d.Tick != 1 {
		t.Errorf("tick = %d, want 1", d.Tick)
	}
}

func TestLastPositionsAreCapped(t *testing.T) {
	s := NewSpace(asciiMap(t, "0..."))
	s.lastCap = 2
	for i, id := range []string{"a", "b", "c"} {
		s.Join(id, id)
		enqueue(t, s, id, 1, Right)
		s.Step(at(i))
		s.Leave(id)
	}
	if got := len(s.last); got != 2 {
		t.Fatalf("last entries = %d, want 2", got)
	}
	if _, ok := s.last["a"]; ok {
		t.Error("oldest entry a was kept")
	}

	if got := s.Join("b", "b").Pos; got != (tilemap.Point{X: 1}) {
		t.Errorf("b rejoined at %v, want last position {1 0}", got)
	}
	if _, ok := s.last["b"]; ok {
		t.Error("b's entry kept after rejoin")
	}
	if got := s.Join("a", "a").Pos; got != (tilemap.Point{}) {
		t.Errorf("evicted a joined at %v, want spawn {0 0}", got)
	}
}
