package main

import (
	"bufio"
	"bytes"
	"fmt"
	"slices"
	"strings"
)

const (
	mapW = 50
	mapH = 25
)

type grid [mapH]string

// Plan is the office drawn as three 50×25 character grids. ~ is outside
// the office, in the floor and solid grids alike: no floor, blocked.
//
// floor: , office carpet tiles  p porcelain  u cubicles carpet, in stations
// three tiles wide  m blue (meeting) and s slate (private) carpets, y light
// and g grey rugs  z rubber  b boxing ring canvas, on the rubber.
// solid (blocks movement): . free  # wall  = glass partition  T table
// D cubicle desks, two rows deep in stations three tiles wide  K counter
// W sink  F stove  G fridge  P plant  S sofa (2 wide)  A armchair
// E bookshelf  V TV (2 wide)  R ring post, on a corner of the canvas
// B punching bag  N bench (2 wide).
// decor (no collision): . nothing  c office chair and h wooden chair,
// facing the table or desk next to it  m monitor, k laptop and d two
// monitors (2 wide) on a desk, showing their screens on its south row and
// their backs on its north row  x computer, f aquarium (2 wide), n papers
// and mug, b books, l lamp, p succulent, v potted plant and t photo frame on
// a desk  a armchair  r runner, on free tiles; o ring ropes, on an edge of
// the canvas; j window  q picture  Q whiteboard (2 wide)  e shelf, on solid
// wall fronts.
type Plan struct {
	Floor, Solid, Decor grid
}

func parsePlan(b []byte) (*Plan, error) {
	var p Plan
	sections := map[string]*grid{"[floor]": &p.Floor, "[solid]": &p.Solid, "[decor]": &p.Decor}
	seen := make(map[string]bool)
	var cur *grid
	row := 0
	sc := bufio.NewScanner(bytes.NewReader(b))
	for n := 1; sc.Scan(); n++ {
		line := strings.TrimRight(sc.Text(), "\r")
		if g, ok := sections[line]; ok {
			if seen[line] {
				return nil, fmt.Errorf("line %d: %s twice", n, line)
			}
			if cur != nil && row != mapH {
				return nil, fmt.Errorf("line %d: section before has %d rows, want %d", n, row, mapH)
			}
			seen[line], cur, row = true, g, 0
			continue
		}
		if line == "" && (cur == nil || row == mapH) {
			continue
		}
		switch {
		case cur == nil:
			return nil, fmt.Errorf("line %d: outside a section", n)
		case row == mapH:
			return nil, fmt.Errorf("line %d: more than %d rows", n, mapH)
		case len(line) != mapW:
			return nil, fmt.Errorf("line %d: %d columns, want %d", n, len(line), mapW)
		}
		cur[row] = line
		row++
	}
	if err := sc.Err(); err != nil {
		return nil, err
	}
	if len(seen) != len(sections) || row != mapH {
		return nil, fmt.Errorf("want sections [floor], [solid] and [decor] of %d rows each", mapH)
	}
	return &p, nil
}

func (g *grid) at(x, y int) byte {
	if x < 0 || y < 0 || x >= mapW || y >= mapH {
		return 0
	}
	return g[y][x]
}

// Layers holds tile names per tile, "" for none.
type Layers struct {
	Floor, Walls, Decor [mapW * mapH]string
}

type tileError struct {
	x, y int
	msg  string
}

func (e *tileError) Error() string { return fmt.Sprintf("tile %d,%d: %s", e.x, e.y, e.msg) }

func errAt(x, y int, format string, args ...any) error {
	return &tileError{x, y, fmt.Sprintf(format, args...)}
}

func (p *Plan) layers() (*Layers, error) {
	var l Layers
	for y := range mapH {
		for x := range mapW {
			i := y*mapW + x
			var err error
			if l.Floor[i], err = p.floorTile(x, y); err != nil {
				return nil, err
			}
			if l.Walls[i], err = p.solidTile(x, y); err != nil {
				return nil, err
			}
			if l.Decor[i], err = p.decorTile(x, y); err != nil {
				return nil, err
			}
		}
	}
	return &l, nil
}

var carpets = map[byte]string{'m': "carpet-blue", 's': "carpet-slate", 'y': "rug-light", 'g': "rug-grey"}

var plainFloors = map[byte]string{',': "floor", 'p': "porcelain", 'z': "rubber"}

func (p *Plan) floorTile(x, y int) (string, error) {
	c := p.Floor.at(x, y)
	if (c == '~') != (p.Solid.at(x, y) == '~') {
		return "", errAt(x, y, "outside in only one of floor and solid")
	}
	switch c {
	case '~':
		return "", nil
	case 'u':
		return p.cubicleFloor(x, y)
	case 'b':
		if p.ringPart(x, y) == "" {
			return "", errAt(x, y, "ring off the rubber floor")
		}
		return nineSlice(&p.Floor, x, y, "ring", 'b')
	}
	if name, ok := plainFloors[c]; ok {
		return name, nil
	}
	if name, ok := carpets[c]; ok {
		return nineSlice(&p.Floor, x, y, name, c)
	}
	return "", errAt(x, y, "unknown floor %q", c)
}

// cubicleFloor frames each station's carpet, chairs included.
func (p *Plan) cubicleFloor(x, y int) (string, error) {
	n, s := p.Floor.at(x, y-1) == 'u', p.Floor.at(x, y+1) == 'u'
	if !n && !s {
		return "", errAt(x, y, "cubicles carpet must be at least 2 rows deep")
	}
	part := ""
	switch {
	case !n:
		part = "n"
	case !s:
		part = "s"
	}
	col, err := station(&p.Floor, x, y)
	if err != nil {
		return "", err
	}
	if part+col == "" {
		return "cubicle-c", nil
	}
	return "cubicle-" + part + col, nil
}

// station picks the part of a run of stations three tiles wide at x, y:
// "w", "" or "e".
func station(g *grid, x, y int) (string, error) {
	c := g.at(x, y)
	x0, x1 := x, x
	for g.at(x0-1, y) == c {
		x0--
	}
	for g.at(x1+1, y) == c {
		x1++
	}
	if (x1-x0+1)%3 != 0 {
		return "", errAt(x, y, "%q is %d wide, not stations of 3", c, x1-x0+1)
	}
	return []string{"w", "", "e"}[(x-x0)%3], nil
}

// ringPart returns the part of the ring canvas at x, y, or "" when there is
// none or it does not stand on a rectangle of rubber floor.
func (p *Plan) ringPart(x, y int) string {
	if p.Floor.at(x, y) != 'b' {
		return ""
	}
	if _, err := nineSlice(&p.Floor, x, y, "", 'z', 'b'); err != nil {
		return ""
	}
	part, err := nineSlice(&p.Floor, x, y, "", 'b')
	if err != nil {
		return ""
	}
	return part[1:]
}

// nineSlice picks the part of a rectangle of the characters same at x, y.
func nineSlice(g *grid, x, y int, prefix string, same ...byte) (string, error) {
	in := func(x, y int) bool { return bytes.IndexByte(same, g.at(x, y)) >= 0 }
	c := g.at(x, y)
	n, s := in(x, y-1), in(x, y+1)
	w, e := in(x-1, y), in(x+1, y)
	if !n && !s || !w && !e {
		return "", errAt(x, y, "%q must be at least 2×2", c)
	}
	part := ""
	switch {
	case !n:
		part = "n"
	case !s:
		part = "s"
	}
	switch {
	case !w:
		part += "w"
	case !e:
		part += "e"
	}
	if part == "" {
		part = "c"
	}
	return prefix + "-" + part, nil
}

// middles are the inner tiles of runs that alternate them, in order.
var middles = map[string][]string{"shelf": {"shelf-1", "shelf-2", "shelf-3"}}

// run picks the part of a horizontal run of equal characters at x, y:
// prefix-w, prefix (or its middles) and prefix-e, with exactly width tiles
// when width > 0.
func run(g *grid, x, y int, prefix string, width int) (string, error) {
	c := g.at(x, y)
	x0, x1 := x, x
	for g.at(x0-1, y) == c {
		x0--
	}
	for g.at(x1+1, y) == c {
		x1++
	}
	n := x1 - x0 + 1
	if n < 2 || width > 0 && n != width {
		return "", errAt(x, y, "%q is %d wide", c, n)
	}
	switch x {
	case x0:
		return prefix + "-w", nil
	case x1:
		return prefix + "-e", nil
	}
	if m := middles[prefix]; m != nil {
		return m[(x-x0-1)%len(m)], nil
	}
	return prefix, nil
}

var counters = []string{"counter-doors", "counter-bottles", "counter-drawer", "counter-jars"}

func (p *Plan) solidTile(x, y int) (string, error) {
	c := p.Solid.at(x, y)
	switch c {
	case '.':
		return "", nil
	case '#', '=':
		return p.wallTile(x, y)
	case 'T':
		return run(&p.Solid, x, y, "table", 0)
	case 'D':
		row := ""
		switch n, s := p.Solid.at(x, y-1) == 'D', p.Solid.at(x, y+1) == 'D'; {
		case !n && s:
			row = "n"
		case n && !s:
			row = "s"
		default:
			return "", errAt(x, y, "desk must be two rows deep")
		}
		col, err := station(&p.Solid, x, y)
		if err != nil {
			return "", err
		}
		return "desk-" + row + col, nil
	case 'E':
		return run(&p.Solid, x, y, "shelf", 0)
	case 'S':
		return run(&p.Solid, x, y, "sofa", 2)
	case 'N':
		return run(&p.Solid, x, y, "bench", 2)
	case 'V':
		return run(&p.Solid, x, y, "tv", 2)
	case 'K':
		return counters[x%len(counters)], nil
	case 'W':
		return "sink", nil
	case 'F':
		return "stove", nil
	case 'G':
		return "fridge", nil
	case 'A':
		return "armchair", nil
	case 'B':
		return "punching-bag", nil
	case '~':
		return "outside", nil
	case 'R':
		if part := p.ringPart(x, y); len(part) == 2 {
			return "ring-post-" + part, nil
		}
		return "", errAt(x, y, "ring post off a corner of the ring")
	case 'P':
		return plants[(x+y)%2], nil
	}
	return "", errAt(x, y, "unknown solid %q", c)
}

func (p *Plan) wall(x, y int) bool { c := p.Solid.at(x, y); return c == '#' || c == '=' }

func (p *Plan) glass(x, y int) bool { return p.Solid.at(x, y) == '=' }

// front reports a wall whose south side faces the room: it shows its face.
func (p *Plan) front(x, y int) bool {
	s := p.Solid.at(x, y+1)
	return p.wall(x, y) && s != 0 && !p.wall(x, y+1) && s != '~'
}

func (p *Plan) top(x, y int) bool { return p.wall(x, y) && !p.front(x, y) }

// wallTile shows a front as a face, with an end next to an opening, and any
// other wall as a top joined to the wall tops around it, glass or solid alike;
// a glass partition's tiles are named glass-<the solid wall's>.
func (p *Plan) wallTile(x, y int) (string, error) {
	name, err := p.solidWallTile(x, y)
	if err != nil || !p.glass(x, y) {
		return name, err
	}
	return "glass-" + name, nil
}

func (p *Plan) solidWallTile(x, y int) (string, error) {
	if p.front(x, y) {
		name := "front"
		if !p.wall(x-1, y) && x > 0 {
			name += "-w"
		}
		if !p.wall(x+1, y) && x+1 < mapW {
			name += "-e"
		}
		return name, nil
	}
	name := "wall-"
	for _, d := range []struct {
		dx, dy int
		s      string
	}{{0, -1, "n"}, {0, 1, "s"}, {1, 0, "e"}, {-1, 0, "w"}} {
		if p.top(x+d.dx, y+d.dy) {
			name += d.s
		}
	}
	if name == "wall-" {
		return "", errAt(x, y, "lone wall")
	}
	return name, nil
}

var plants = []string{"plant", "plant-2"}

var pictures = []string{"picture", "picture-2", "picture-3"}

func (p *Plan) decorTile(x, y int) (string, error) {
	c := p.Decor.at(x, y)
	s := p.Solid.at(x, y)
	switch {
	case c == '.':
		return "", nil
	case strings.IndexByte("charo", c) >= 0 && s != '.':
		return "", errAt(x, y, "%q must be on a free tile", c)
	case strings.IndexByte("jqQe", c) >= 0 && (!p.front(x, y) || p.glass(x, y)):
		return "", errAt(x, y, "%q must be on a solid wall front", c)
	case strings.IndexByte("mkdxfnblpvt", c) >= 0 && s != 'D':
		return "", errAt(x, y, "%q must be on a desk", c)
	}
	switch c {
	case 'c':
		return p.chairTile(x, y, "chair")
	case 'h':
		return p.chairTile(x, y, "wood-chair")
	case 'm':
		return "monitor-" + p.facing(x, y), nil
	case 'k':
		return "laptop-" + p.facing(x, y), nil
	case 'd':
		part, err := run(&p.Decor, x, y, "", 2)
		return "dual-" + p.facing(x, y) + part, err
	case 'f':
		return run(&p.Decor, x, y, "aquarium", 2)
	case 'x', 'n', 'b', 'l', 'p', 'v', 't':
		return deskItems[c], nil
	case 'a':
		return "armchair", nil
	case 'r':
		return run(&p.Decor, x, y, "runner", 0)
	case 'j':
		return "window", nil
	case 'q':
		return pictures[x%len(pictures)], nil
	case 'Q':
		return run(&p.Decor, x, y, "whiteboard", 2)
	case 'e':
		return "wall-shelf", nil
	case 'o':
		switch p.ringPart(x, y) {
		case "n", "s":
			return "ring-rope-h", nil
		case "w", "e":
			return "ring-rope-v", nil
		}
		return "", errAt(x, y, "ropes off an edge of the ring")
	}
	return "", errAt(x, y, "unknown decor %q", c)
}

var deskItems = map[byte]string{
	'x': "desk-computer", 'n': "desk-papers", 'b': "desk-books", 'l': "desk-lamp",
	'p': "desk-plant", 'v': "desk-pot", 't': "desk-photo",
}

// facing is "front" on a desk's south row, where screens face the camera
// and the chair south of the desk, and "back" on its north row.
func (p *Plan) facing(x, y int) string {
	if p.Solid.at(x, y-1) == 'D' {
		return "front"
	}
	return "back"
}

// cubicleChairs colors the chairs at the cubicle desks by row: light grey
// north of the desks, navy south of them.
var cubicleChairs = map[string]string{"s": "-light", "n": "-navy"}

// chairTile turns a chair towards the table or desk next to it, preferring
// one to the south or north.
func (p *Plan) chairTile(x, y int, prefix string) (string, error) {
	for _, d := range []struct {
		dx, dy int
		dir    string
	}{{0, 1, "s"}, {0, -1, "n"}, {1, 0, "e"}, {-1, 0, "w"}} {
		switch p.Solid.at(x+d.dx, y+d.dy) {
		case 'D':
			if prefix == "chair" {
				return prefix + "-" + d.dir + cubicleChairs[d.dir], nil
			}
			return prefix + "-" + d.dir, nil
		case 'T':
			return prefix + "-" + d.dir, nil
		}
	}
	return "", errAt(x, y, "chair without a table or desk next to it")
}

// gids numbers the tiles in manifest order, and fails on a name missing
// from it or an entry no tile uses, so the atlas holds only used tiles.
func gids(l *Layers) (map[string]int, error) {
	used := make(map[string]bool)
	for _, layer := range [][]string{l.Floor[:], l.Walls[:], l.Decor[:]} {
		for _, name := range layer {
			if name != "" {
				used[name] = true
			}
		}
	}
	ids := make(map[string]int, len(manifest))
	for i, e := range manifest {
		if _, dup := ids[e.Name]; dup {
			return nil, fmt.Errorf("manifest: %q twice", e.Name)
		}
		if !used[e.Name] {
			return nil, fmt.Errorf("manifest: %q is not used", e.Name)
		}
		ids[e.Name] = i + 1
	}
	var missing []string
	for name := range used {
		if ids[name] == 0 {
			missing = append(missing, name)
		}
	}
	if len(missing) > 0 {
		slices.Sort(missing)
		return nil, fmt.Errorf("manifest: no tile for %s", strings.Join(missing, ", "))
	}
	return ids, nil
}
