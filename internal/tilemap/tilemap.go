// Package tilemap loads Tiled JSON maps and answers collision queries.
package tilemap

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
)

const TileSize = 32

type Point struct {
	X, Y int
}

func (p Point) Add(q Point) Point {
	return Point{p.X + q.X, p.Y + q.Y}
}

type Map struct {
	Width, Height int
	Spawns        []Point
	blocked       []bool
}

// Blocked reports whether p is a wall or lies outside the map.
func (m *Map) Blocked(p Point) bool {
	if p.X < 0 || p.Y < 0 || p.X >= m.Width || p.Y >= m.Height {
		return true
	}
	return m.blocked[p.Y*m.Width+p.X]
}

type tiledMap struct {
	Orientation string       `json:"orientation"`
	Infinite    bool         `json:"infinite"`
	Width       int          `json:"width"`
	Height      int          `json:"height"`
	TileWidth   int          `json:"tilewidth"`
	TileHeight  int          `json:"tileheight"`
	Layers      []tiledLayer `json:"layers"`
}

type tiledLayer struct {
	Name     string        `json:"name"`
	Type     string        `json:"type"`
	Encoding string        `json:"encoding"`
	Width    int           `json:"width"`
	Height   int           `json:"height"`
	Data     []int         `json:"data"`
	Objects  []tiledObject `json:"objects"`
}

type tiledObject struct {
	X     float64 `json:"x"`
	Y     float64 `json:"y"`
	Point bool    `json:"point"`
}

func LoadFile(path string) (*Map, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	m, err := Load(f)
	if err != nil {
		return nil, fmt.Errorf("load %s: %w", path, err)
	}
	return m, nil
}

func Load(r io.Reader) (*Map, error) {
	var tm tiledMap
	if err := json.NewDecoder(r).Decode(&tm); err != nil {
		return nil, fmt.Errorf("decode tiled map: %w", err)
	}
	switch {
	case tm.Orientation != "orthogonal":
		return nil, fmt.Errorf("orientation %q: only orthogonal is supported", tm.Orientation)
	case tm.Infinite:
		return nil, errors.New("infinite maps are not supported")
	case tm.TileWidth != TileSize || tm.TileHeight != TileSize:
		return nil, fmt.Errorf("tile size %dx%d: want %dx%d", tm.TileWidth, tm.TileHeight, TileSize, TileSize)
	case tm.Width <= 0 || tm.Height <= 0:
		return nil, fmt.Errorf("invalid map size %dx%d", tm.Width, tm.Height)
	}

	if _, err := tm.tileLayer("floor"); err != nil {
		return nil, err
	}
	walls, err := tm.tileLayer("walls")
	if err != nil {
		return nil, err
	}
	spawns, err := tm.layer("spawns", "objectgroup")
	if err != nil {
		return nil, err
	}

	m := &Map{
		Width:   tm.Width,
		Height:  tm.Height,
		blocked: make([]bool, len(walls.Data)),
	}
	for i, gid := range walls.Data {
		m.blocked[i] = gid != 0
	}
	for _, o := range spawns.Objects {
		if !o.Point {
			continue
		}
		p := Point{int(math.Floor(o.X / TileSize)), int(math.Floor(o.Y / TileSize))}
		if m.Blocked(p) {
			return nil, fmt.Errorf("spawn at tile %d,%d is blocked", p.X, p.Y)
		}
		m.Spawns = append(m.Spawns, p)
	}
	if len(m.Spawns) == 0 {
		return nil, errors.New("map has no spawn points")
	}
	return m, nil
}

func (tm *tiledMap) layer(name, typ string) (*tiledLayer, error) {
	for i := range tm.Layers {
		l := &tm.Layers[i]
		if l.Name != name {
			continue
		}
		if l.Type != typ {
			return nil, fmt.Errorf("layer %q is %q, want %q", name, l.Type, typ)
		}
		return l, nil
	}
	return nil, fmt.Errorf("missing layer %q", name)
}

func (tm *tiledMap) tileLayer(name string) (*tiledLayer, error) {
	l, err := tm.layer(name, "tilelayer")
	if err != nil {
		return nil, err
	}
	if l.Encoding != "" && l.Encoding != "csv" {
		return nil, fmt.Errorf("layer %q: encoding %q is not supported", name, l.Encoding)
	}
	if l.Width != tm.Width || l.Height != tm.Height || len(l.Data) != tm.Width*tm.Height {
		return nil, fmt.Errorf("layer %q: size does not match map %dx%d", name, tm.Width, tm.Height)
	}
	return l, nil
}
