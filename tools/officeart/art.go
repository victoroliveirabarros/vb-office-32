package main

import (
	"bufio"
	"bytes"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/draw"
	"image/png"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
)

const (
	srcTile = 16
	srcGap  = 1
	scale   = 2
	tile    = srcTile * scale
	// Each atlas cell holds a tile and a 1 px copy of its edges around it,
	// which is margin 1 and spacing 2 for Tiled.
	cell        = tile + 2
	atlasColumn = 16
)

// sheetFiles are relative to the repository root.
var sheetFiles = map[string]string{
	"rpg":    "art/kenney/roguelike-rpg-pack/roguelikeSheet_transparent.png",
	"indoor": "art/kenney/roguelike-indoors/roguelikeIndoor_transparent.png",
}

// Source is one 16 px tile: (Col, Row) of a Kenney sheet, or of a sprite in
// art/custom when Sheet is "custom:<name>".
type Source struct {
	Sheet    string
	Col, Row int
}

// Paint recolors the tiles it is set on: each "rrggbb" color in Map becomes
// the other, any other color stays as drawn. Every color it maps must occur
// in at least one of its tiles, so a sheet that changes cannot leave a stale
// entry behind unnoticed.
type Paint struct {
	Name string
	Map  map[string]string
}

func hexColor(s string) (color.NRGBA, error) {
	v, err := strconv.ParseUint(s, 16, 32)
	if err != nil || len(s) != 6 && len(s) != 8 {
		return color.NRGBA{}, fmt.Errorf("color %q", s)
	}
	if len(s) == 6 {
		v = v<<8 | 0xff
	}
	return color.NRGBA{uint8(v >> 24), uint8(v >> 16), uint8(v >> 8), uint8(v)}, nil
}

type art struct {
	sheets map[string]image.Image
	paints map[*Paint]map[color.NRGBA]color.NRGBA
	// painted holds the source colors each paint met.
	painted map[*Paint]map[color.NRGBA]bool
}

func loadArt(root string) (*art, error) {
	a := &art{
		sheets:  make(map[string]image.Image),
		paints:  make(map[*Paint]map[color.NRGBA]color.NRGBA),
		painted: make(map[*Paint]map[color.NRGBA]bool),
	}
	for name, rel := range sheetFiles {
		img, err := readPNG(filepath.Join(root, rel))
		if err != nil {
			return nil, err
		}
		a.sheets[name] = img
	}
	for _, s := range manifest {
		name, ok := strings.CutPrefix(s.Sheet, "custom:")
		if !ok || a.sheets[s.Sheet] != nil {
			continue
		}
		path := filepath.Join(root, "art", "custom", name+".txt")
		b, err := os.ReadFile(path)
		if err != nil {
			return nil, err
		}
		img, err := parseSprite(b)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", path, err)
		}
		a.sheets[s.Sheet] = img
	}
	for _, e := range manifest {
		if e.Paint == nil || a.paints[e.Paint] != nil {
			continue
		}
		m := make(map[color.NRGBA]color.NRGBA, len(e.Paint.Map))
		for from, to := range e.Paint.Map {
			f, err := hexColor(from)
			if err != nil || len(from) != 6 {
				return nil, fmt.Errorf("paint %s: source color %q", e.Paint.Name, from)
			}
			t, err := hexColor(to)
			if err != nil {
				return nil, fmt.Errorf("paint %s: %w", e.Paint.Name, err)
			}
			m[f] = t
		}
		a.paints[e.Paint] = m
		a.painted[e.Paint] = make(map[color.NRGBA]bool)
	}
	return a, nil
}

// entryImage returns the 16 px tile of e, painted.
func (a *art) entryImage(e Entry) (*image.NRGBA, error) {
	img, err := a.tileImage(e.Source)
	if err != nil || e.Paint == nil {
		return img, err
	}
	m, seen := a.paints[e.Paint], a.painted[e.Paint]
	for y := range srcTile {
		for x := range srcTile {
			c := img.NRGBAAt(x, y)
			if c.A != 255 {
				continue
			}
			if to, ok := m[c]; ok {
				img.SetNRGBA(x, y, to)
				seen[c] = true
			}
		}
	}
	return img, nil
}

// unusedPaint reports the colors of a paint that none of its tiles has.
func (a *art) unusedPaint() error {
	var errs []error
	for p, m := range a.paints {
		var missing []string
		for from := range m {
			if !a.painted[p][from] {
				missing = append(missing, fmt.Sprintf("%02x%02x%02x", from.R, from.G, from.B))
			}
		}
		if len(missing) > 0 {
			slices.Sort(missing)
			errs = append(errs, fmt.Errorf("paint %s: no tile has %s", p.Name, strings.Join(missing, ", ")))
		}
	}
	return errors.Join(errs...)
}

func readPNG(path string) (image.Image, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	img, err := png.Decode(f)
	if err != nil {
		return nil, fmt.Errorf("decode %s: %w", path, err)
	}
	return img, nil
}

// tileImage returns the 16 px tile s points at.
func (a *art) tileImage(s Source) (*image.NRGBA, error) {
	img, ok := a.sheets[s.Sheet]
	if !ok {
		return nil, fmt.Errorf("unknown sheet %q", s.Sheet)
	}
	step := srcTile + srcGap
	if strings.HasPrefix(s.Sheet, "custom:") {
		step = srcTile
	}
	r := image.Rect(s.Col*step, s.Row*step, s.Col*step+srcTile, s.Row*step+srcTile).Add(img.Bounds().Min)
	if s.Col < 0 || s.Row < 0 || !r.In(img.Bounds()) {
		return nil, fmt.Errorf("tile %d,%d is outside sheet %q", s.Col, s.Row, s.Sheet)
	}
	out := image.NewNRGBA(image.Rect(0, 0, srcTile, srcTile))
	draw.Draw(out, out.Bounds(), img, r.Min, draw.Src)
	return out, nil
}

// buildAtlas scales each tile 2× with nearest neighbour and extrudes it by
// 1 px, so that sampling at a tile's edge never reads its neighbour.
func (a *art) buildAtlas(tiles []Entry) (*image.NRGBA, error) {
	rows := (len(tiles) + atlasColumn - 1) / atlasColumn
	atlas := image.NewNRGBA(image.Rect(0, 0, atlasColumn*cell, rows*cell))
	for i, e := range tiles {
		src, err := a.entryImage(e)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", e.Name, err)
		}
		ox, oy := i%atlasColumn*cell, i/atlasColumn*cell
		for y := -1; y <= tile; y++ {
			for x := -1; x <= tile; x++ {
				sx := min(max(x, 0), tile-1) / scale
				sy := min(max(y, 0), tile-1) / scale
				atlas.Set(ox+1+x, oy+1+y, src.At(sx, sy))
			}
		}
	}
	return atlas, nil
}

// parseSprite reads a sprite drawn as text: palette lines "<char> <rrggbb>",
// "<char> <rrggbbaa>" for a see-through color or "<char> transparent", a blank line, then one line per pixel row. Lines
// starting with # are comments. Its size must be a multiple of 16.
func parseSprite(b []byte) (image.Image, error) {
	palette := make(map[byte]color.NRGBA)
	var rows []string
	inGrid := false
	sc := bufio.NewScanner(bytes.NewReader(b))
	for sc.Scan() {
		line := strings.TrimRight(sc.Text(), " \t\r")
		switch {
		case strings.HasPrefix(line, "#"):
		case !inGrid && line == "":
			inGrid = len(palette) > 0
		case !inGrid:
			key, value, ok := strings.Cut(line, " ")
			if !ok || len(key) != 1 {
				return nil, fmt.Errorf("palette line %q", line)
			}
			if value == "transparent" {
				palette[key[0]] = color.NRGBA{}
				continue
			}
			c, err := hexColor(value)
			if err != nil {
				return nil, fmt.Errorf("palette %w", err)
			}
			palette[key[0]] = c
		case line != "":
			rows = append(rows, line)
		}
	}
	if err := sc.Err(); err != nil {
		return nil, err
	}
	if len(rows) == 0 || len(rows)%srcTile != 0 || len(rows[0])%srcTile != 0 {
		return nil, fmt.Errorf("size must be a multiple of %d", srcTile)
	}
	img := image.NewNRGBA(image.Rect(0, 0, len(rows[0]), len(rows)))
	for y, row := range rows {
		if len(row) != len(rows[0]) {
			return nil, fmt.Errorf("row %d has %d pixels, want %d", y, len(row), len(rows[0]))
		}
		for x := range len(row) {
			c, ok := palette[row[x]]
			if !ok {
				return nil, fmt.Errorf("row %d: %q is not in the palette", y, row[x])
			}
			img.SetNRGBA(x, y, c)
		}
	}
	return img, nil
}
