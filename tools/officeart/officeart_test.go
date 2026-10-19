package main

import (
	"bytes"
	"encoding/json"
	"image"
	"image/png"
	"os"
	"reflect"
	"strings"
	"testing"

	"github.com/victoroliveirabarros/vb-office-32/internal/tilemap"
)

const root = "../.."

// TestGolden fails when the committed map or atlas differ from what the
// generator makes now: run `make art` after changing the art or the plan.
func TestGolden(t *testing.T) {
	out, err := generate(root)
	if err != nil {
		t.Fatal(err)
	}

	committed, err := os.ReadFile(root + "/" + mapFile)
	if err != nil {
		t.Fatal(err)
	}
	var got, want any
	if err := json.Unmarshal(out.TMJ, &got); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(committed, &want); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("%s is out of date: run make art", mapFile)
	}

	f, err := os.Open(root + "/" + atlasFile)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	img, err := png.Decode(f)
	if err != nil {
		t.Fatal(err)
	}
	if !samePixels(img, out.Atlas) {
		t.Errorf("%s is out of date: run make art", atlasFile)
	}

	m, err := tilemap.Load(bytes.NewReader(out.TMJ))
	if err != nil {
		t.Fatal(err)
	}
	if m.Width != mapW || m.Height != mapH || len(m.Spawns) != len(spawns) || len(m.Zones) != len(zones) {
		t.Errorf("map %dx%d with %d spawns and %d zones", m.Width, m.Height, len(m.Spawns), len(m.Zones))
	}
	if b := out.Atlas.Bounds(); b.Dx() != atlasColumn*cell || b.Dy()%cell != 0 {
		t.Errorf("atlas is %dx%d, want %d wide in rows of %d", b.Dx(), b.Dy(), atlasColumn*cell, cell)
	}
}

func samePixels(a, b image.Image) bool {
	if a.Bounds() != b.Bounds() {
		return false
	}
	for y := a.Bounds().Min.Y; y < a.Bounds().Max.Y; y++ {
		for x := a.Bounds().Min.X; x < a.Bounds().Max.X; x++ {
			r1, g1, b1, a1 := a.At(x, y).RGBA()
			r2, g2, b2, a2 := b.At(x, y).RGBA()
			if a1 != a2 || a1 != 0 && (r1 != r2 || g1 != g2 || b1 != b2) {
				return false
			}
		}
	}
	return true
}

func TestExtrusion(t *testing.T) {
	out, err := generate(root)
	if err != nil {
		t.Fatal(err)
	}
	for i := range manifest {
		ox, oy := i%atlasColumn*cell, i/atlasColumn*cell
		for k := range tile {
			edges := [][2]image.Point{
				{{ox + 1 + k, oy}, {ox + 1 + k, oy + 1}},
				{{ox + 1 + k, oy + cell - 1}, {ox + 1 + k, oy + cell - 2}},
				{{ox, oy + 1 + k}, {ox + 1, oy + 1 + k}},
				{{ox + cell - 1, oy + 1 + k}, {ox + cell - 2, oy + 1 + k}},
			}
			for _, e := range edges {
				if out.Atlas.At(e[0].X, e[0].Y) != out.Atlas.At(e[1].X, e[1].Y) {
					t.Fatalf("tile %q: pixel %v does not repeat the edge %v", manifest[i].Name, e[0], e[1])
				}
			}
		}
	}
}

func TestSameMask(t *testing.T) {
	out, err := generate(root)
	if err != nil {
		t.Fatal(err)
	}
	if err := sameMask(out.TMJ, out.TMJ); err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(out.TMJ, &m); err != nil {
		t.Fatal(err)
	}
	for _, l := range m["layers"].([]any) {
		if l := l.(map[string]any); l["name"] == "walls" {
			l["data"].([]any)[17*mapW+12] = 1.0
		}
	}
	changed, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	err = sameMask(out.TMJ, changed)
	if err == nil || !strings.Contains(err.Error(), "tile 12,17") {
		t.Fatalf("sameMask = %v, want an error at tile 12,17", err)
	}
}

func TestPlanErrors(t *testing.T) {
	type edit struct {
		section string
		x, y    int
		c       byte
	}
	tests := []struct {
		name  string
		edits []edit
	}{
		{"unknown floor", []edit{{"floor", 12, 12, '?'}}},
		{"unknown solid", []edit{{"solid", 12, 12, '?'}}},
		{"unknown decor", []edit{{"decor", 12, 12, '?'}}},
		{"outside in the solid grid only", []edit{{"solid", 12, 17, '~'}}},
		{"outside in the floor grid only", []edit{{"floor", 12, 17, '~'}}},
		{"lone chair", []edit{{"decor", 12, 17, 'c'}}},
		{"chair on a desk", []edit{{"decor", 18, 16, 'c'}}},
		{"monitor on the floor", []edit{{"decor", 12, 17, 'm'}}},
		{"window on a wall top", []edit{{"decor", 11, 5, 'j'}}},
		{"picture on the floor", []edit{{"decor", 12, 17, 'q'}}},
		{"lone wall", []edit{{"floor", 5, 21, ','}, {"solid", 5, 21, '#'}}},
		{"one-tile table", []edit{{"solid", 12, 17, 'T'}}},
		{"three-tile sofa", []edit{{"solid", 36, 3, 'S'}}},
		{"ring off a grey carpet", []edit{{"floor", 12, 17, 'b'}}},
		{"ring post off a corner", []edit{{"solid", 44, 13, 'R'}}},
		{"ropes off an edge", []edit{{"decor", 44, 13, 'o'}}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			p, err := parsePlan(officePlan)
			if err != nil {
				t.Fatal(err)
			}
			for _, e := range tt.edits {
				g := map[string]*grid{"floor": &p.Floor, "solid": &p.Solid, "decor": &p.Decor}[e.section]
				row := []byte(g[e.y])
				row[e.x] = e.c
				g[e.y] = string(row)
			}
			l, err := p.layers()
			if err == nil {
				_, err = gids(l)
			}
			if err == nil {
				t.Fatal("plan accepted, want error")
			}
		})
	}

	for _, bad := range []string{"", "[floor]\n,,,\n", strings.Replace(string(officePlan), "[decor]", "[floor]", 1)} {
		if _, err := parsePlan([]byte(bad)); err == nil {
			t.Errorf("parsePlan(%.20q) succeeded, want error", bad)
		}
	}
}

func TestParseSprite(t *testing.T) {
	row := strings.Repeat(".", 16) + "\n"
	ok := ". transparent\nk 404040\n\n" + strings.Repeat(row, 16)
	if _, err := parseSprite([]byte(ok)); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{
		". transparent\n\n" + strings.Repeat(row, 15),
		". transparent\n\n" + strings.Repeat(row, 15) + strings.Repeat("x", 16) + "\n",
		". 40404\n\n" + strings.Repeat(row, 16),
	} {
		if _, err := parseSprite([]byte(bad)); err == nil {
			t.Errorf("parseSprite succeeded, want error for %.40q", bad)
		}
	}
}
