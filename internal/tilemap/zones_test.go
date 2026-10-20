package tilemap

import (
	"encoding/json"
	"strings"
	"testing"
)

func zone(id, name, kind string, x, y, w, h float64) map[string]any {
	return map[string]any{
		"id": 1, "name": name, "x": x, "y": y, "width": w, "height": h, "rotation": 0,
		"properties": []any{
			map[string]any{"name": "id", "type": "string", "value": id},
			map[string]any{"name": "kind", "type": "string", "value": kind},
		},
	}
}

// withZones adds a zones layer to the fixture; mod changes its first object.
func withZones(mod func(o map[string]any), zones ...map[string]any) func(m map[string]any) {
	return func(m map[string]any) {
		if mod != nil {
			mod(zones[0])
		}
		objects := make([]any, len(zones))
		for i, z := range zones {
			objects[i] = z
		}
		m["layers"] = append(m["layers"].([]any), map[string]any{"name": "zones", "type": "objectgroup", "objects": objects})
	}
}

func TestLoadZones(t *testing.T) {
	m, err := Load(strings.NewReader(fixture(withZones(nil,
		zone("sala-1", "Sala 1 — reunião", "meeting", 64, 32, 48, 32),
		zone("cabine", "Cabine", "private", 112, 0, 32, 64),
	))))
	if err != nil {
		t.Fatal(err)
	}
	want := []Zone{
		{ID: "sala-1", Name: "Sala 1 — reunião", Kind: Meeting, Rect: Rect{64, 32, 48, 32}},
		{ID: "cabine", Name: "Cabine", Kind: Private, Rect: Rect{112, 0, 32, 64}},
	}
	if len(m.Zones) != len(want) || m.Zones[0] != want[0] || m.Zones[1] != want[1] {
		t.Errorf("zones = %+v, want %+v", m.Zones, want)
	}
	tests := []struct {
		p    Point
		want int
	}{
		{Point{1, 1}, -1},
		{Point{2, 1}, 0},
		{Point{3, 1}, 1}, // center x=112 is past the end of sala-1
		{Point{3, 0}, 1},
		{Point{3, 2}, -1},
		{Point{2, 0}, -1},
		{Point{-1, 1}, -1},
		{Point{4, 1}, -1},
	}
	for _, tt := range tests {
		if got := m.ZoneAt(tt.p); got != tt.want {
			t.Errorf("ZoneAt(%v) = %d, want %d", tt.p, got, tt.want)
		}
	}

	m, err = Load(strings.NewReader(fixture(nil)))
	if err != nil {
		t.Fatal(err)
	}
	if m.Zones != nil || m.ZoneAt(Point{1, 1}) != -1 {
		t.Errorf("without a zones layer: zones = %v, ZoneAt = %d", m.Zones, m.ZoneAt(Point{1, 1}))
	}

	for _, name := range []string{strings.Repeat("ã", maxZoneName), "x"} {
		z := zone(strings.Repeat("a", maxZoneIDLen), name, "private", 64, 32, 64, 32)
		if _, err := Load(strings.NewReader(fixture(withZones(nil, z)))); err != nil {
			t.Errorf("name %q, longest id: %v", name, err)
		}
	}
}

func TestLoadZonesInvalid(t *testing.T) {
	set := func(k string, v any) func(o map[string]any) {
		return func(o map[string]any) { o[k] = v }
	}
	prop := func(name string, v any) func(o map[string]any) {
		return func(o map[string]any) {
			for _, p := range o["properties"].([]any) {
				if p := p.(map[string]any); p["name"] == name {
					p["value"] = v
				}
			}
		}
	}
	dropProp := func(name string) func(o map[string]any) {
		return func(o map[string]any) {
			var ps []any
			for _, p := range o["properties"].([]any) {
				if p.(map[string]any)["name"] != name {
					ps = append(ps, p)
				}
			}
			o["properties"] = ps
		}
	}
	ok := func() map[string]any { return zone("sala", "Sala", "meeting", 64, 32, 64, 32) }
	tests := []struct {
		name  string
		mod   func(o map[string]any)
		zones []map[string]any
		want  string
	}{
		{"point", set("point", true), nil, "not a rectangle"},
		{"ellipse", set("ellipse", true), nil, "not a rectangle"},
		{"polygon", set("polygon", []any{map[string]any{"x": 0, "y": 0}}), nil, "not a rectangle"},
		{"polyline", set("polyline", []any{map[string]any{"x": 0, "y": 0}}), nil, "not a rectangle"},
		{"text", set("text", map[string]any{"text": "Sala"}), nil, "not a rectangle"},
		{"tile object", set("gid", 1), nil, "not a rectangle"},
		{"rotated", set("rotation", 90), nil, "rotated"},
		{"zero width", set("width", 0), nil, "size"},
		{"negative height", set("height", -32), nil, "size"},
		{"no id", dropProp("id"), nil, "missing property \"id\""},
		{"empty id", prop("id", ""), nil, "id \"\""},
		{"uppercase id", prop("id", "Sala"), nil, "want [a-z0-9-]"},
		{"id with space", prop("id", "sala 1"), nil, "want [a-z0-9-]"},
		{"id too long", prop("id", strings.Repeat("a", maxZoneIDLen+1)), nil, "want [a-z0-9-]"},
		{"id not a string", prop("id", 1), nil, "not a string"},
		{"no kind", dropProp("kind"), nil, "missing property \"kind\""},
		{"unknown kind", prop("kind", "lounge"), nil, "kind \"lounge\""},
		{"kind not a string", prop("kind", true), nil, "not a string"},
		{"empty name", set("name", ""), nil, "name must have"},
		{"blank name", set("name", "  "), nil, "name must have"},
		{"name too long", set("name", strings.Repeat("ã", maxZoneName+1)), nil, "name must have"},
		{"no tile", nil, []map[string]any{zone("sala", "Sala", "meeting", 0, 0, 16, 16)}, "covers no tile"},
		{"outside the map", nil, []map[string]any{zone("sala", "Sala", "meeting", 200, 0, 64, 64)}, "covers no tile"},
		{"duplicate id", nil, []map[string]any{ok(), zone("sala", "Outra", "private", 0, 0, 32, 32)}, "duplicate id"},
		{"overlap", nil, []map[string]any{ok(), zone("outra", "Outra", "private", 96, 0, 32, 64)}, "overlap at tile 3,1"},
		{"spawn in zone", nil, []map[string]any{zone("sala", "Sala", "meeting", 32, 32, 32, 32)}, "spawn at tile 1,1 is in zone"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			zones := tt.zones
			if zones == nil {
				zones = []map[string]any{ok()}
			}
			_, err := Load(strings.NewReader(fixture(withZones(tt.mod, zones...))))
			if err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("err = %v, want %q", err, tt.want)
			}
		})
	}

	wrongType := func(m map[string]any) {
		m["layers"] = append(m["layers"].([]any), map[string]any{"name": "zones", "type": "tilelayer", "width": 4, "height": 3, "data": make([]int, 12)})
	}
	if _, err := Load(strings.NewReader(fixture(wrongType))); err == nil {
		t.Error("zones as a tile layer: Load succeeded, want error")
	}
	tooMany := make([]map[string]any, maxZones+1)
	for i := range tooMany {
		tooMany[i] = ok()
	}
	if _, err := Load(strings.NewReader(fixture(withZones(nil, tooMany...)))); err == nil {
		t.Error("too many zones: Load succeeded, want error")
	}
}

func TestLoadDeskZone(t *testing.T) {
	m, err := Load(strings.NewReader(fixture(withZones(nil, zone("mesa-01", "Mesa 1", "desk", 64, 0, 64, 64)))))
	if err != nil {
		t.Fatal(err)
	}
	if m.Zones[0].Kind != Desk || m.ZoneIndex("mesa-01") != 0 || m.ZoneIndex("mesa-02") != -1 {
		t.Errorf("zones = %+v, ZoneIndex = %d", m.Zones, m.ZoneIndex("mesa-01"))
	}

	walls := zone("parede", "Parede", "private", 0, 0, 128, 32)
	if _, err := Load(strings.NewReader(fixture(withZones(nil, walls)))); err == nil || !strings.Contains(err.Error(), `zone "parede" has no walkable tile`) {
		t.Errorf("zone over walls only: err = %v", err)
	}
}

// gridMap builds a map from rows of '#' walls and '.' floor, with one spawn
// at the 'S'.
func gridMap(t *testing.T, rows []string, zones ...map[string]any) *Map {
	t.Helper()
	w, h := len(rows[0]), len(rows)
	walls := make([]int, w*h)
	var spawn [2]float64
	for y, row := range rows {
		for x, c := range row {
			switch c {
			case '#':
				walls[y*w+x] = 1
			case 'S':
				spawn = [2]float64{float64(x*TileSize + 16), float64(y*TileSize + 16)}
			}
		}
	}
	objects := make([]any, len(zones))
	for i, z := range zones {
		objects[i] = z
	}
	b, err := json.Marshal(map[string]any{
		"orientation": "orthogonal", "width": w, "height": h, "tilewidth": 32, "tileheight": 32,
		"layers": []any{
			map[string]any{"name": "floor", "type": "tilelayer", "width": w, "height": h, "data": make([]int, w*h)},
			map[string]any{"name": "walls", "type": "tilelayer", "width": w, "height": h, "data": walls},
			map[string]any{"name": "spawns", "type": "objectgroup", "objects": []any{map[string]any{"point": true, "x": spawn[0], "y": spawn[1]}}},
			map[string]any{"name": "zones", "type": "objectgroup", "objects": objects},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	m, err := Load(strings.NewReader(string(b)))
	if err != nil {
		t.Fatal(err)
	}
	return m
}

func TestSeat(t *testing.T) {
	m := gridMap(t, []string{
		".........",
		".......#.",
		".........",
		"........S",
	},
		zone("centro", "Centro", "desk", 0, 0, 96, 96),
		zone("empate", "Empate", "desk", 128, 0, 64, 64), // four tiles as near
		zone("parede", "Parede", "desk", 224, 0, 32, 96), // the center tile is a wall
	)
	for _, tt := range []struct {
		zone string
		want Point
	}{
		{"centro", Point{1, 1}},
		{"empate", Point{4, 0}},
		{"parede", Point{7, 0}},
	} {
		if got := m.Seat(m.ZoneIndex(tt.zone)); got != tt.want {
			t.Errorf("Seat(%s) = %v, want %v", tt.zone, got, tt.want)
		}
	}
}

func TestOutside(t *testing.T) {
	m := gridMap(t, []string{
		"S....#",
		"#.####",
		"#....#",
		"######",
	},
		zone("sala", "Sala", "private", 32, 32, 160, 64),
		zone("fundo", "Fundo", "private", 128, 0, 32, 32),
	)
	for _, tt := range []struct {
		from, want Point
	}{
		{Point{4, 2}, Point{1, 0}}, // the only way out is up the corridor
		{Point{1, 1}, Point{1, 0}},
		{Point{4, 0}, Point{3, 0}}, // nearest neighbour wins, not the spawn
		{Point{0, 0}, Point{0, 0}}, // already outside
		{Point{5, 0}, Point{0, 0}}, // a wall falls back to the spawn
	} {
		for range 2 {
			if got := m.Outside(tt.from); got != tt.want {
				t.Errorf("Outside(%v) = %v, want %v", tt.from, got, tt.want)
			}
		}
	}

	closed := gridMap(t, []string{
		"S.#..",
		"###..",
	}, zone("ilha", "Ilha", "private", 96, 0, 64, 64))
	if got := closed.Outside(Point{3, 1}); got != (Point{0, 0}) {
		t.Errorf("Outside from a closed zone = %v, want the spawn", got)
	}
}
