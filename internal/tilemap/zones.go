package tilemap

import (
	"errors"
	"fmt"
	"math"
	"strings"
	"unicode/utf8"
)

type Kind string

const (
	Meeting Kind = "meeting"
	Private Kind = "private"
	Desk    Kind = "desk"
)

func (k Kind) Valid() bool {
	return k == Meeting || k == Private || k == Desk
}

const (
	maxZones     = 255
	maxZoneIDLen = 32
	maxZoneName  = 40
)

// Rect is in pixels, as Tiled stores it.
type Rect struct {
	X, Y, W, H float64
}

// Zone is an area where only those inside hear each other. A tile belongs to
// it when the tile's center lies in [X, X+W) × [Y, Y+H).
type Zone struct {
	ID   string
	Name string
	Kind Kind
	Rect Rect
}

// ZoneAt returns the index in Zones of the zone holding p, or -1.
func (m *Map) ZoneAt(p Point) int {
	if m.zoneAt == nil || p.X < 0 || p.Y < 0 || p.X >= m.Width || p.Y >= m.Height {
		return -1
	}
	return int(m.zoneAt[p.Y*m.Width+p.X]) - 1
}

// ZoneIndex returns the index in Zones of the zone with that id, or -1.
func (m *Map) ZoneIndex(id string) int {
	for i, z := range m.Zones {
		if z.ID == id {
			return i
		}
	}
	return -1
}

// Seat returns the walkable tile of Zones[i] nearest the center of its
// rectangle, the topmost and then leftmost on a tie.
func (m *Map) Seat(i int) Point {
	r := m.Zones[i].Rect
	cx, cy := r.X+r.W/2, r.Y+r.H/2
	best, bestD := Point{-1, -1}, math.Inf(1)
	for y := range m.Height {
		for x := range m.Width {
			p := Point{x, y}
			if m.ZoneAt(p) != i || m.Blocked(p) {
				continue
			}
			dx := float64(x*TileSize+TileSize/2) - cx
			dy := float64(y*TileSize+TileSize/2) - cy
			// Row-major order keeps the first of equal distances.
			if d := dx*dx + dy*dy; d < bestD {
				best, bestD = p, d
			}
		}
	}
	return best
}

// Outside returns the walkable tile in no zone nearest from by walking, or
// the first spawn when there is none.
func (m *Map) Outside(from Point) Point {
	if m.Blocked(from) {
		return m.Spawns[0]
	}
	seen := make([]bool, m.Width*m.Height)
	seen[from.Y*m.Width+from.X] = true
	queue := []Point{from}
	for len(queue) > 0 {
		p := queue[0]
		queue = queue[1:]
		if m.ZoneAt(p) < 0 {
			return p
		}
		for _, d := range [...]Point{{0, -1}, {0, 1}, {-1, 0}, {1, 0}} {
			q := p.Add(d)
			if !m.Blocked(q) && !seen[q.Y*m.Width+q.X] {
				seen[q.Y*m.Width+q.X] = true
				queue = append(queue, q)
			}
		}
	}
	return m.Spawns[0]
}

type tiledProperty struct {
	Name  string `json:"name"`
	Type  string `json:"type"`
	Value any    `json:"value"`
}

func (o *tiledObject) property(name string) (string, error) {
	for _, p := range o.Properties {
		if p.Name != name {
			continue
		}
		s, ok := p.Value.(string)
		if !ok || (p.Type != "" && p.Type != "string") {
			return "", fmt.Errorf("property %q is not a string", name)
		}
		return s, nil
	}
	return "", fmt.Errorf("missing property %q", name)
}

func (o *tiledObject) rectangle() bool {
	return !o.Point && !o.Ellipse && o.Polygon == nil && o.Polyline == nil && o.Text == nil && o.GID == 0
}

// loadZones reads the optional zones layer into m, whose walls and size are
// already set.
func (m *Map) loadZones(tm *tiledMap) error {
	l, err := tm.layer("zones", "objectgroup")
	if errors.Is(err, errMissingLayer) {
		return nil
	}
	if err != nil {
		return err
	}
	if len(l.Objects) > maxZones {
		return fmt.Errorf("%d zones: at most %d", len(l.Objects), maxZones)
	}
	m.zoneAt = make([]uint8, m.Width*m.Height)
	ids := make(map[string]bool, len(l.Objects))
	for i := range l.Objects {
		z, err := newZone(&l.Objects[i])
		if err != nil {
			return fmt.Errorf("zone object %d: %w", l.Objects[i].ID, err)
		}
		if ids[z.ID] {
			return fmt.Errorf("zone %q: duplicate id", z.ID)
		}
		ids[z.ID] = true
		m.Zones = append(m.Zones, z)
		if err := m.markZone(len(m.Zones) - 1); err != nil {
			return err
		}
	}
	return nil
}

func newZone(o *tiledObject) (Zone, error) {
	switch {
	case !o.rectangle():
		return Zone{}, errors.New("not a rectangle")
	case o.Rotation != 0:
		return Zone{}, errors.New("rotated")
	case o.Width <= 0 || o.Height <= 0:
		return Zone{}, fmt.Errorf("size %vx%v", o.Width, o.Height)
	}
	id, err := o.property("id")
	if err != nil {
		return Zone{}, err
	}
	if !validZoneID(id) {
		return Zone{}, fmt.Errorf("id %q: want [a-z0-9-]{1,%d}", id, maxZoneIDLen)
	}
	kind, err := o.property("kind")
	if err != nil {
		return Zone{}, err
	}
	if !Kind(kind).Valid() {
		return Zone{}, fmt.Errorf("zone %q: kind %q", id, kind)
	}
	if strings.TrimSpace(o.Name) == "" || !utf8.ValidString(o.Name) || utf8.RuneCountInString(o.Name) > maxZoneName {
		return Zone{}, fmt.Errorf("zone %q: name must have 1 to %d characters", id, maxZoneName)
	}
	return Zone{
		ID:   id,
		Name: o.Name,
		Kind: Kind(kind),
		Rect: Rect{X: o.X, Y: o.Y, W: o.Width, H: o.Height},
	}, nil
}

func validZoneID(id string) bool {
	if id == "" || len(id) > maxZoneIDLen {
		return false
	}
	for _, c := range []byte(id) {
		if !('a' <= c && c <= 'z' || '0' <= c && c <= '9' || c == '-') {
			return false
		}
	}
	return true
}

// markZone claims the tiles of Zones[i], which must not belong to another
// zone.
func (m *Map) markZone(i int) error {
	z := m.Zones[i]
	n, walkable := 0, 0
	for y := range m.Height {
		cy := float64(y*TileSize + TileSize/2)
		if cy < z.Rect.Y || cy >= z.Rect.Y+z.Rect.H {
			continue
		}
		for x := range m.Width {
			cx := float64(x*TileSize + TileSize/2)
			if cx < z.Rect.X || cx >= z.Rect.X+z.Rect.W {
				continue
			}
			if o := m.ZoneAt(Point{x, y}); o >= 0 {
				return fmt.Errorf("zones %q and %q overlap at tile %d,%d", m.Zones[o].ID, z.ID, x, y)
			}
			m.zoneAt[y*m.Width+x] = uint8(i + 1)
			n++
			if !m.Blocked(Point{x, y}) {
				walkable++
			}
		}
	}
	if n == 0 {
		return fmt.Errorf("zone %q covers no tile", z.ID)
	}
	if walkable == 0 {
		return fmt.Errorf("zone %q has no walkable tile", z.ID)
	}
	return nil
}
