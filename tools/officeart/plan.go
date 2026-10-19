package main

import (
	"bufio"
	"bytes"
	"fmt"
	"slices"
	"strings"
)

const (
	mapW = 40
	mapH = 25
)

type grid [mapH]string

// Plan is the office drawn as three 40×25 character grids.
//
// floor: , floor  w wood  1 2 3 carpets of Sala 1, Sala 2 and Cabine.
// solid (blocks movement): . free  # wall  T table  D desk  K counter
// W sink  F stove  G fridge  P plant  S sofa (2 wide)  A armchair
// E bookshelf  V TV (2 wide).
// decor (no collision): . nothing  c chair, facing the table or desk next
// to it  m monitor on a desk, facing the chair next to it  a armchair
// r runner (3 wide), on free tiles; j window  q picture  Q panel (2 wide)
// e shelf, on wall fronts.
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

func (p *Plan) floorTile(x, y int) (string, error) {
	c := p.Floor.at(x, y)
	switch c {
	case ',':
		return "floor", nil
	case 'w':
		return "wood", nil
	case '1', '2', '3':
		return nineSlice(&p.Floor, x, y, "carpet-"+string(c))
	}
	return "", errAt(x, y, "unknown floor %q", c)
}

// nineSlice picks the part of a rectangle of equal characters at x, y.
func nineSlice(g *grid, x, y int, prefix string) (string, error) {
	c := g.at(x, y)
	n, s := g.at(x, y-1) == c, g.at(x, y+1) == c
	w, e := g.at(x-1, y) == c, g.at(x+1, y) == c
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
	case '#':
		return p.wallTile(x, y)
	case 'T':
		return run(&p.Solid, x, y, "table", 0)
	case 'D':
		return run(&p.Solid, x, y, "desk", 0)
	case 'E':
		return run(&p.Solid, x, y, "shelf", 0)
	case 'S':
		return run(&p.Solid, x, y, "sofa", 2)
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
	case 'P':
		if (x+y)%2 == 0 {
			return "plant", nil
		}
		return "plant-2", nil
	}
	return "", errAt(x, y, "unknown solid %q", c)
}

func (p *Plan) wall(x, y int) bool { return p.Solid.at(x, y) == '#' }

// front reports a wall whose south side faces the room: it shows its face.
func (p *Plan) front(x, y int) bool { return p.wall(x, y) && y+1 < mapH && !p.wall(x, y+1) }

func (p *Plan) top(x, y int) bool { return p.wall(x, y) && !p.front(x, y) }

// wallTile shows a front as a face, with an end next to an opening, and any
// other wall as a top joined to the wall tops around it.
func (p *Plan) wallTile(x, y int) (string, error) {
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

var pictures = []string{"picture", "picture-2", "picture-3"}

func (p *Plan) decorTile(x, y int) (string, error) {
	c := p.Decor.at(x, y)
	s := p.Solid.at(x, y)
	switch {
	case c == '.':
		return "", nil
	case strings.IndexByte("car", c) >= 0 && s != '.':
		return "", errAt(x, y, "%q must be on a free tile", c)
	case strings.IndexByte("jqQe", c) >= 0 && !p.front(x, y):
		return "", errAt(x, y, "%q must be on a wall front", c)
	}
	switch c {
	case 'c':
		return p.chairTile(x, y)
	case 'm':
		return p.monitorTile(x, y)
	case 'a':
		return "armchair", nil
	case 'r':
		return run(&p.Decor, x, y, "runner", 0)
	case 'j':
		return "window", nil
	case 'q':
		return pictures[x%len(pictures)], nil
	case 'Q':
		return run(&p.Decor, x, y, "panel", 2)
	case 'e':
		return "wall-shelf", nil
	}
	return "", errAt(x, y, "unknown decor %q", c)
}

// chairTile turns a chair towards the table or desk next to it, preferring
// one to the south or north.
func (p *Plan) chairTile(x, y int) (string, error) {
	for _, d := range []struct {
		dx, dy int
		dir    string
	}{{0, 1, "s"}, {0, -1, "n"}, {1, 0, "e"}, {-1, 0, "w"}} {
		if c := p.Solid.at(x+d.dx, y+d.dy); c == 'T' || c == 'D' {
			return "chair-" + d.dir, nil
		}
	}
	return "", errAt(x, y, "chair without a table or desk next to it")
}

// monitorTile shows a monitor's screen when its chair is to the south, the
// way the camera looks, and its back when the chair is to the north.
func (p *Plan) monitorTile(x, y int) (string, error) {
	if p.Solid.at(x, y) != 'D' {
		return "", errAt(x, y, "monitor must be on a desk")
	}
	switch {
	case p.Decor.at(x, y+1) == 'c':
		return "monitor-front", nil
	case p.Decor.at(x, y-1) == 'c':
		return "monitor-back", nil
	}
	return "", errAt(x, y, "monitor without a chair north or south of it")
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
