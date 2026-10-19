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
	{"Sala 1", "sala-1", "meeting", 32, 32, 320, 256},
	{"Sala 2", "sala-2", "meeting", 384, 32, 320, 256},
	{"Cabine", "cabine", "private", 736, 32, 192, 256},
}

var spawns = [][2]int{
	{304, 528}, {336, 528}, {560, 528}, {592, 528}, {816, 528}, {848, 528}, {304, 720}, {560, 720},
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
