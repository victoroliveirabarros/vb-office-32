package tilemap

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

// fixture builds a 4x3 map: walls on the border except for a free tile at
// (3,1) on the right edge, spawns given in pixels.
func fixture(mod func(m map[string]any)) string {
	walls := []int{
		3, 3, 3, 3,
		3, 0, 0, 0,
		3, 3, 3, 3,
	}
	m := map[string]any{
		"orientation": "orthogonal",
		"width":       4,
		"height":      3,
		"tilewidth":   32,
		"tileheight":  32,
		"layers": []any{
			map[string]any{"name": "floor", "type": "tilelayer", "width": 4, "height": 3, "data": make([]int, 12)},
			map[string]any{"name": "walls", "type": "tilelayer", "width": 4, "height": 3, "data": walls},
			// decor never blocks, even over free tiles.
			map[string]any{"name": "decor", "type": "tilelayer", "width": 4, "height": 3, "data": []int{
				0, 0, 0, 0,
				0, 5, 5, 5,
				0, 0, 0, 0,
			}},
			map[string]any{"name": "spawns", "type": "objectgroup", "objects": []any{
				map[string]any{"point": true, "x": 48.0, "y": 63.9},
				map[string]any{"point": false, "x": 0.0, "y": 0.0},
			}},
		},
	}
	if mod != nil {
		mod(m)
	}
	b, err := json.Marshal(m)
	if err != nil {
		panic(err)
	}
	return string(b)
}

func TestLoad(t *testing.T) {
	m, err := Load(strings.NewReader(fixture(nil)))
	if err != nil {
		t.Fatal(err)
	}
	if m.Width != 4 || m.Height != 3 {
		t.Errorf("size = %dx%d, want 4x3", m.Width, m.Height)
	}
	if len(m.Spawns) != 1 || m.Spawns[0] != (Point{1, 1}) {
		t.Errorf("spawns = %v, want [{1 1}]", m.Spawns)
	}

	tests := []struct {
		p       Point
		blocked bool
	}{
		{Point{1, 1}, false},
		{Point{3, 1}, false},
		{Point{0, 1}, true},
		{Point{1, 0}, true},
		{Point{4, 1}, true},
		{Point{-1, 1}, true},
		{Point{1, 3}, true},
		{Point{1, -1}, true},
	}
	for _, tt := range tests {
		if got := m.Blocked(tt.p); got != tt.blocked {
			t.Errorf("Blocked(%v) = %v, want %v", tt.p, got, tt.blocked)
		}
	}
}

func TestLoadInvalid(t *testing.T) {
	layers := func(m map[string]any) []any { return m["layers"].([]any) }
	tests := []struct {
		name string
		mod  func(m map[string]any)
	}{
		{"isometric", func(m map[string]any) { m["orientation"] = "isometric" }},
		{"infinite", func(m map[string]any) { m["infinite"] = true }},
		{"tile size", func(m map[string]any) { m["tilewidth"] = 16 }},
		{"missing floor", func(m map[string]any) { m["layers"] = layers(m)[1:] }},
		{"missing walls", func(m map[string]any) {
			l := layers(m)
			m["layers"] = []any{l[0], l[2], l[3]}
		}},
		{"missing spawns", func(m map[string]any) { m["layers"] = layers(m)[:3] }},
		{"walls wrong type", func(m map[string]any) { layers(m)[1].(map[string]any)["type"] = "objectgroup" }},
		{"walls wrong size", func(m map[string]any) { layers(m)[1].(map[string]any)["data"] = []int{0} }},
		{"base64", func(m map[string]any) { layers(m)[1].(map[string]any)["encoding"] = "base64" }},
		{"no spawn", func(m map[string]any) { layers(m)[3].(map[string]any)["objects"] = []any{} }},
		{"blocked spawn", func(m map[string]any) {
			layers(m)[3].(map[string]any)["objects"] = []any{map[string]any{"point": true, "x": 1.0, "y": 1.0}}
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if _, err := Load(strings.NewReader(fixture(tt.mod))); err == nil {
				t.Fatal("Load succeeded, want error")
			}
		})
	}

	if _, err := Load(strings.NewReader("{")); err == nil {
		t.Error("Load(malformed json) succeeded, want error")
	}
}

func TestOfficeMap(t *testing.T) {
	m, err := LoadFile("../../maps/office.tmj")
	if err != nil {
		t.Fatal(err)
	}
	if m.Width != 50 || m.Height != 25 {
		t.Errorf("size = %dx%d, want 50x25", m.Width, m.Height)
	}
	if len(m.Spawns) < 8 {
		t.Errorf("got %d spawns, want at least 8", len(m.Spawns))
	}

	want := map[string]Kind{"reuniao": Meeting, "privada": Private, "ringue": Private}
	for i := 1; i <= 12; i++ {
		want[fmt.Sprintf("mesa-%02d", i)] = Desk
	}
	if len(m.Zones) != 15 {
		t.Errorf("got %d zones, want 15", len(m.Zones))
	}
	for _, z := range m.Zones {
		if want[z.ID] != z.Kind {
			t.Errorf("zone %q is %q, want %q", z.ID, z.Kind, want[z.ID])
		}
	}
	desks := []struct {
		id   string
		rect Rect
		seat Point
	}{
		{"mesa-01", Rect{480, 416, 96, 64}, Point{16, 13}},
		{"mesa-02", Rect{576, 416, 96, 64}, Point{19, 13}},
		{"mesa-03", Rect{672, 416, 96, 64}, Point{22, 13}},
		{"mesa-04", Rect{480, 480, 96, 64}, Point{16, 16}},
		{"mesa-05", Rect{576, 480, 96, 64}, Point{19, 16}},
		{"mesa-06", Rect{672, 480, 96, 64}, Point{22, 16}},
		{"mesa-07", Rect{832, 416, 96, 64}, Point{27, 13}},
		{"mesa-08", Rect{928, 416, 96, 64}, Point{30, 13}},
		{"mesa-09", Rect{1024, 416, 96, 64}, Point{33, 13}},
		{"mesa-10", Rect{832, 480, 96, 64}, Point{27, 16}},
		{"mesa-11", Rect{928, 480, 96, 64}, Point{30, 16}},
		{"mesa-12", Rect{1024, 480, 96, 64}, Point{33, 16}},
	}
	inDesk := make([]bool, m.Width*m.Height)
	for n, d := range desks {
		i := m.ZoneIndex(d.id)
		if i != 3+n {
			t.Errorf("ZoneIndex(%q) = %d, want %d", d.id, i, 3+n)
			continue
		}
		z := m.Zones[i]
		if z.Rect != d.rect || z.Name != fmt.Sprintf("Mesa %d", n+1) {
			t.Errorf("%s = %+v, want %v named Mesa %d", d.id, z, d.rect, n+1)
		}
		if got := m.Seat(i); got != d.seat {
			t.Errorf("Seat(%s) = %v, want %v", d.id, got, d.seat)
		}
		tiles, walkable := 0, 0
		for y := range m.Height {
			for x := range m.Width {
				if p := (Point{x, y}); m.ZoneAt(p) == i {
					inDesk[y*m.Width+x] = true
					tiles++
					if !m.Blocked(p) {
						walkable++
						if p.Y != d.seat.Y {
							t.Errorf("%s: walkable %v off the chair row", d.id, p)
						}
					}
				}
			}
		}
		if tiles != 6 || walkable != 3 {
			t.Errorf("%s: %d tiles, %d walkable, want 6 and 3", d.id, tiles, walkable)
		}
		if out := m.Outside(d.seat); m.ZoneAt(out) >= 0 || m.Blocked(out) || out.X != d.seat.X || abs(out.Y-d.seat.Y) != 1 {
			t.Errorf("Outside(%v) = %v, want the tile just past the chair", d.seat, out)
		}
	}
	zoneID := func(p Point) string {
		if i := m.ZoneAt(p); i >= 0 {
			return m.Zones[i].ID
		}
		return ""
	}
	// One door into each room from the office, outside the room; the tile
	// past it is in the room.
	for _, door := range []struct {
		at     []Point
		inside Point
		zone   string
	}{
		{[]Point{{18, 9}, {19, 9}}, Point{Y: -1}, "reuniao"},
		{[]Point{{11, 13}, {11, 14}}, Point{X: -1}, "privada"},
		{[]Point{{38, 13}, {38, 14}}, Point{X: 1}, "ringue"},
	} {
		for _, p := range door.at {
			if m.Blocked(p) || m.ZoneAt(p) >= 0 {
				t.Errorf("door %v: blocked %v, zone %d", p, m.Blocked(p), m.ZoneAt(p))
			}
			if got := zoneID(p.Add(door.inside)); got != door.zone {
				t.Errorf("past door %v: zone %q, want %q", p, got, door.zone)
			}
		}
	}
	// The kitchen opens wide onto the office, and neither is a zone.
	for x := 29; x <= 35; x++ {
		if p := (Point{x, 9}); m.Blocked(p) {
			t.Errorf("kitchen opening %v is blocked", p)
		}
	}
	for _, p := range []Point{{27, 2}, {32, 7}, {36, 8}, {32, 9}, {24, 20}, {13, 22}} {
		if m.Blocked(p) || m.ZoneAt(p) >= 0 {
			t.Errorf("%v: blocked %v, zone %q, want free in no zone", p, m.Blocked(p), zoneID(p))
		}
	}
	for _, p := range m.Spawns {
		if p.X < 12 || p.X > 37 || p.Y < 10 || p.Y > 23 {
			t.Errorf("spawn %v is outside the office", p)
		}
		if m.ZoneAt(p) >= 0 {
			t.Errorf("spawn %v is in zone %q", p, zoneID(p))
		}
	}
	// Outside the office's outline nothing is walkable.
	for _, p := range []Point{{0, 0}, {10, 8}, {39, 0}, {49, 8}, {0, 18}, {10, 24}, {39, 18}, {49, 24}} {
		if !m.Blocked(p) {
			t.Errorf("%v outside the office is free", p)
		}
	}

	// Every free tile is reachable from the spawns, and every free tile out
	// of the desks without stepping on one.
	reach := func(from Point, avoid []bool) []bool {
		seen := make([]bool, m.Width*m.Height)
		seen[from.Y*m.Width+from.X] = true
		queue := []Point{from}
		for len(queue) > 0 {
			p := queue[0]
			queue = queue[1:]
			for _, d := range []Point{{0, -1}, {0, 1}, {-1, 0}, {1, 0}} {
				q := p.Add(d)
				if !m.Blocked(q) && !seen[q.Y*m.Width+q.X] && (avoid == nil || !avoid[q.Y*m.Width+q.X]) {
					seen[q.Y*m.Width+q.X] = true
					queue = append(queue, q)
				}
			}
		}
		return seen
	}
	all, around := reach(m.Spawns[0], nil), reach(m.Spawns[0], inDesk)
	free := 0
	for y := range m.Height {
		for x := range m.Width {
			p, i := Point{x, y}, y*m.Width+x
			if m.Blocked(p) {
				continue
			}
			if !all[i] {
				t.Errorf("free tile %v is unreachable from the spawns", p)
			}
			if !inDesk[i] {
				free++
				if !around[i] {
					t.Errorf("free tile %v is reachable only through a desk", p)
				}
			}
		}
	}
	if free != 548 {
		t.Errorf("%d free tiles out of the desks, want 548", free)
	}
}

func abs(n int) int {
	if n < 0 {
		return -n
	}
	return n
}
