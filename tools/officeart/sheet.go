package main

import (
	"fmt"
	"image"
	"image/color"
	"image/draw"
	"image/png"
	"os"
	"path/filepath"
	"strings"
)

// glyphs is a 3×5 font for the review sheets' labels.
var glyphs = map[rune][5]string{
	'0': {"111", "101", "101", "101", "111"},
	'1': {"010", "110", "010", "010", "111"},
	'2': {"111", "001", "111", "100", "111"},
	'3': {"111", "001", "111", "001", "111"},
	'4': {"101", "101", "111", "001", "001"},
	'5': {"111", "100", "111", "001", "111"},
	'6': {"111", "100", "111", "101", "111"},
	'7': {"111", "001", "010", "010", "010"},
	'8': {"111", "101", "111", "101", "111"},
	'9': {"111", "101", "111", "001", "111"},
	',': {"000", "000", "000", "010", "100"},
	'*': {"000", "101", "010", "101", "000"},
	'#': {"101", "111", "101", "111", "101"},
	'r': {"000", "110", "100", "100", "100"},
	'i': {"010", "000", "010", "010", "010"},
	'c': {"000", "011", "100", "100", "011"},
}

func label(img draw.Image, x, y, s int, text string, c color.Color) {
	for _, r := range text {
		g := glyphs[r]
		for row := range 5 {
			for col := range 3 {
				if g[row][col] == '1' {
					draw.Draw(img, image.Rect(x+col*s, y+row*s, x+(col+1)*s, y+(row+1)*s), image.NewUniform(c), image.Point{}, draw.Src)
				}
			}
		}
		x += 4 * s
	}
}

// writeSheets writes index.png, every atlas tile at 4× with its gid and
// source tile (r rpg, i indoor, c custom; * when painted), index.txt with the same in words,
// and map.png, the map as the game draws it.
func writeSheets(dir string, out *output) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	const (
		zoom  = 4
		cellW = srcTile*zoom + 12
		cellH = srcTile*zoom + 34
		cols  = 12
	)
	rows := (len(manifest) + cols - 1) / cols
	index := image.NewNRGBA(image.Rect(0, 0, cols*cellW, rows*cellH))
	draw.Draw(index, index.Bounds(), image.NewUniform(color.White), image.Point{}, draw.Src)
	var text strings.Builder
	for i, e := range manifest {
		src, err := out.art.entryImage(e)
		if err != nil {
			return err
		}
		ox, oy := i%cols*cellW+6, i/cols*cellH+4
		for y := range srcTile * zoom {
			for x := range srcTile * zoom {
				bg := color.NRGBA{205, 205, 205, 255}
				if (x/16+y/16)%2 == 0 {
					bg = color.NRGBA{235, 235, 235, 255}
				}
				index.Set(ox+x, oy+y, bg)
			}
		}
		draw.Draw(index, image.Rect(ox, oy, ox+srcTile*zoom, oy+srcTile*zoom), scaled(src, zoom), image.Point{}, draw.Over)
		sheet := e.Sheet[:1]
		label(index, ox, oy+srcTile*zoom+4, 2, fmt.Sprintf("#%d", i+1), color.NRGBA{170, 0, 0, 255})
		paint := ""
		if e.Paint != nil {
			paint = " paint " + e.Paint.Name
			sheet += "*"
		}
		label(index, ox, oy+srcTile*zoom+18, 2, fmt.Sprintf("%s%d,%d", sheet, e.Col, e.Row), color.NRGBA{0, 0, 170, 255})
		fmt.Fprintf(&text, "%3d  %-18s %s %d,%d%s\n", i+1, e.Name, e.Sheet, e.Col, e.Row, paint)
	}
	if err := writePNG(filepath.Join(dir, "index.png"), index); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(dir, "index.txt"), []byte(text.String()), 0o644); err != nil {
		return err
	}

	view := image.NewNRGBA(image.Rect(0, 0, mapW*tile, mapH*tile))
	draw.Draw(view, view.Bounds(), image.NewUniform(color.NRGBA{29, 31, 39, 255}), image.Point{}, draw.Src)
	for _, layer := range [][]string{out.Layers.Floor[:], out.Layers.Walls[:], out.Layers.Decor[:]} {
		for i, name := range layer {
			if name == "" {
				continue
			}
			g := out.IDs[name] - 1
			sp := image.Pt(g%atlasColumn*cell+1, g/atlasColumn*cell+1)
			x, y := i%mapW*tile, i/mapW*tile
			draw.Draw(view, image.Rect(x, y, x+tile, y+tile), out.Atlas, sp, draw.Over)
		}
	}
	return writePNG(filepath.Join(dir, "map.png"), view)
}

func scaled(src image.Image, s int) image.Image {
	b := src.Bounds()
	out := image.NewNRGBA(image.Rect(0, 0, b.Dx()*s, b.Dy()*s))
	for y := range b.Dy() * s {
		for x := range b.Dx() * s {
			out.Set(x, y, src.At(b.Min.X+x/s, b.Min.Y+y/s))
		}
	}
	return out
}

func writePNG(path string, img image.Image) error {
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	if err := png.Encode(f, img); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}
