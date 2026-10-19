package tilemap

import (
	"encoding/json"
	"slices"
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
	if m.Width != 40 || m.Height != 25 {
		t.Errorf("size = %dx%d, want 40x25", m.Width, m.Height)
	}
	if len(m.Spawns) < 6 {
		t.Errorf("got %d spawns, want at least 6", len(m.Spawns))
	}

	kinds := make(map[Kind]int)
	for _, z := range m.Zones {
		kinds[z.Kind]++
	}
	if kinds[Meeting] != 2 || kinds[Private] < 1 {
		t.Errorf("zones = %+v, want 2 meeting and at least 1 private", m.Zones)
	}
	// Doors lead into each room but stay outside it.
	for _, door := range []Point{{6, 9}, {17, 9}, {25, 9}, {26, 9}} {
		if m.Blocked(door) || m.ZoneAt(door) >= 0 {
			t.Errorf("door %v: blocked %v, zone %d", door, m.Blocked(door), m.ZoneAt(door))
		}
		if in := m.ZoneAt(door.Add(Point{Y: -1})); in < 0 {
			t.Errorf("tile above door %v is in no zone", door)
		}
	}

	// Every free tile is reachable from the spawns.
	seen := make([]bool, m.Width*m.Height)
	queue := slices.Clone(m.Spawns)
	for _, p := range queue {
		seen[p.Y*m.Width+p.X] = true
	}
	for len(queue) > 0 {
		p := queue[0]
		queue = queue[1:]
		for _, d := range []Point{{0, -1}, {0, 1}, {-1, 0}, {1, 0}} {
			q := p.Add(d)
			if !m.Blocked(q) && !seen[q.Y*m.Width+q.X] {
				seen[q.Y*m.Width+q.X] = true
				queue = append(queue, q)
			}
		}
	}
	for y := range m.Height {
		for x := range m.Width {
			if p := (Point{x, y}); !m.Blocked(p) && !seen[y*m.Width+x] {
				t.Errorf("free tile %v is unreachable from the spawns", p)
			}
		}
	}
}
