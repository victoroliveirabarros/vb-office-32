package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
)

const atlasImage = "../web/public/game/office-tiles.png"

type zone struct {
	Name, ID, Kind string
	X, Y, W, H     int
}

// Zones and spawns are in pixels, as Tiled stores them.
var zones = []zone{
	{"Sala de reunião", "reuniao", "meeting", 384, 32, 448, 256},
	{"Sala privada", "privada", "private", 32, 320, 320, 224},
	{"Ringue de box", "ringue", "private", 1248, 320, 320, 224},
	// One desk per station: the chair row and the desk row, 3×2 tiles.
	{"Mesa 1", "mesa-01", "desk", 480, 416, 96, 64},
	{"Mesa 2", "mesa-02", "desk", 576, 416, 96, 64},
	{"Mesa 3", "mesa-03", "desk", 672, 416, 96, 64},
	{"Mesa 4", "mesa-04", "desk", 480, 480, 96, 64},
	{"Mesa 5", "mesa-05", "desk", 576, 480, 96, 64},
	{"Mesa 6", "mesa-06", "desk", 672, 480, 96, 64},
	{"Mesa 7", "mesa-07", "desk", 832, 416, 96, 64},
	{"Mesa 8", "mesa-08", "desk", 928, 416, 96, 64},
	{"Mesa 9", "mesa-09", "desk", 1024, 416, 96, 64},
	{"Mesa 10", "mesa-10", "desk", 832, 480, 96, 64},
	{"Mesa 11", "mesa-11", "desk", 928, 480, 96, 64},
	{"Mesa 12", "mesa-12", "desk", 1024, 480, 96, 64},
}

// Areas name the open floor for the client's lists; the server ignores them.
var areas = []zone{
	{Name: "Copa", ID: "copa", X: 864, Y: 32, W: 352, H: 256},
	{Name: "Escritório aberto", ID: "escritorio", X: 384, Y: 320, W: 832, H: 448},
}

// Spawns stand on the office's walkways, at tile centers.
var spawns = [][2]int{
	{464, 368}, {624, 368}, {784, 368}, {944, 368}, {1104, 368},
	{464, 592}, {624, 592}, {784, 592}, {944, 592}, {1104, 592},
}

type tmjMap struct {
	Type             string    `json:"type"`
	Version          string    `json:"version"`
	TiledVersion     string    `json:"tiledversion"`
	Orientation      string    `json:"orientation"`
	RenderOrder      string    `json:"renderorder"`
	Infinite         bool      `json:"infinite"`
	Width            int       `json:"width"`
	Height           int       `json:"height"`
	TileWidth        int       `json:"tilewidth"`
	TileHeight       int       `json:"tileheight"`
	CompressionLevel int       `json:"compressionlevel"`
	NextLayerID      int       `json:"nextlayerid"`
	NextObjectID     int       `json:"nextobjectid"`
	Layers           []any     `json:"layers"`
	Tilesets         []tileset `json:"tilesets"`
}

type tileLayer struct {
	ID      int    `json:"id"`
	Name    string `json:"name"`
	Type    string `json:"type"`
	X       int    `json:"x"`
	Y       int    `json:"y"`
	Width   int    `json:"width"`
	Height  int    `json:"height"`
	Opacity int    `json:"opacity"`
	Visible bool   `json:"visible"`
	// Data is a placeholder replaced by the rows of gids, one per line.
	Data string `json:"data"`
}

type objectGroup struct {
	ID        int      `json:"id"`
	Name      string   `json:"name"`
	Type      string   `json:"type"`
	DrawOrder string   `json:"draworder"`
	X         int      `json:"x"`
	Y         int      `json:"y"`
	Opacity   int      `json:"opacity"`
	Visible   bool     `json:"visible"`
	Objects   []object `json:"objects"`
}

type object struct {
	ID         int        `json:"id"`
	Name       string     `json:"name"`
	Type       string     `json:"type"`
	Point      bool       `json:"point,omitempty"`
	X          int        `json:"x"`
	Y          int        `json:"y"`
	Width      int        `json:"width"`
	Height     int        `json:"height"`
	Rotation   int        `json:"rotation"`
	Visible    bool       `json:"visible"`
	Properties []property `json:"properties,omitempty"`
}

type property struct {
	Name  string `json:"name"`
	Type  string `json:"type"`
	Value string `json:"value"`
}

type tileset struct {
	FirstGID    int    `json:"firstgid"`
	Name        string `json:"name"`
	Image       string `json:"image"`
	ImageWidth  int    `json:"imagewidth"`
	ImageHeight int    `json:"imageheight"`
	TileWidth   int    `json:"tilewidth"`
	TileHeight  int    `json:"tileheight"`
	Margin      int    `json:"margin"`
	Spacing     int    `json:"spacing"`
	Columns     int    `json:"columns"`
	TileCount   int    `json:"tilecount"`
}

func placeholder(name string) string { return "@@" + name + "@@" }

// encodeTMJ writes the map as Tiled JSON, with each tile layer's gids one
// map row per line.
func encodeTMJ(l *Layers, ids map[string]int, atlasW, atlasH int) ([]byte, error) {
	data := map[string][mapW * mapH]string{"floor": l.Floor, "walls": l.Walls, "decor": l.Decor}
	m := tmjMap{
		Type: "map", Version: "1.10", TiledVersion: "1.10.2",
		Orientation: "orthogonal", RenderOrder: "right-down",
		Width: mapW, Height: mapH, TileWidth: tile, TileHeight: tile,
		CompressionLevel: -1,
		Tilesets: []tileset{{
			FirstGID: 1, Name: "office", Image: atlasImage,
			ImageWidth: atlasW, ImageHeight: atlasH, TileWidth: tile, TileHeight: tile,
			Margin: 1, Spacing: 2, Columns: atlasColumn, TileCount: len(manifest),
		}},
	}
	for _, name := range []string{"floor", "walls", "decor"} {
		m.Layers = append(m.Layers, tileLayer{
			ID: len(m.Layers) + 1, Name: name, Type: "tilelayer",
			Width: mapW, Height: mapH, Opacity: 1, Visible: true, Data: placeholder(name),
		})
	}
	id := 1
	group := func(name string) objectGroup {
		return objectGroup{ID: len(m.Layers) + 1, Name: name, Type: "objectgroup", DrawOrder: "topdown", Opacity: 1, Visible: true, Objects: []object{}}
	}
	sp := group("spawns")
	for _, s := range spawns {
		sp.Objects = append(sp.Objects, object{ID: id, Name: "spawn", Point: true, X: s[0], Y: s[1], Visible: true})
		id++
	}
	m.Layers = append(m.Layers, sp)
	zs := group("zones")
	for _, z := range zones {
		zs.Objects = append(zs.Objects, object{
			ID: id, Name: z.Name, X: z.X, Y: z.Y, Width: z.W, Height: z.H, Visible: true,
			Properties: []property{{"id", "string", z.ID}, {"kind", "string", z.Kind}},
		})
		id++
	}
	m.Layers = append(m.Layers, zs)
	as := group("areas")
	for _, a := range areas {
		as.Objects = append(as.Objects, object{
			ID: id, Name: a.Name, X: a.X, Y: a.Y, Width: a.W, Height: a.H, Visible: true,
			Properties: []property{{"id", "string", a.ID}},
		})
		id++
	}
	m.Layers = append(m.Layers, as)
	m.NextLayerID, m.NextObjectID = len(m.Layers)+1, id

	b, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return nil, err
	}
	for name, tiles := range data {
		var rows strings.Builder
		rows.WriteString("[\n")
		for y := range mapH {
			rows.WriteString("        ")
			for x := range mapW {
				name := tiles[y*mapW+x]
				gid := 0
				if name != "" {
					gid = ids[name]
				}
				rows.WriteString(strconv.Itoa(gid))
				if y*mapW+x < mapW*mapH-1 {
					rows.WriteByte(',')
				}
			}
			rows.WriteByte('\n')
		}
		rows.WriteString("      ]")
		ph := strconv.Quote(placeholder(name))
		if bytes.Count(b, []byte(ph)) != 1 {
			return nil, fmt.Errorf("layer %q placeholder", name)
		}
		b = bytes.Replace(b, []byte(ph), []byte(rows.String()), 1)
	}
	return append(b, '\n'), nil
}
