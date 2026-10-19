package main

import (
	"bytes"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/draw"
	"image/gif"
	"image/png"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"github.com/victoroliveirabarros/vb-office-32/internal/avatar"
)

// The avatar art lives in art/custom/avatar as text sprites of 16×24 frames,
// drawn in the key colors of internal/avatar. body, pants and shirt have one
// row per view (down, up, right) and one column per frame (idle, step A,
// step B); hair and acc have one row per style and one column per view, and
// take the bob of each frame. The left view mirrors the right one.
const (
	avatarW      = 16
	avatarH      = 24
	avatarFrames = 3
	avatarDir    = "art/custom/avatar"
	partsFile    = "web/public/game/avatar-parts.png"
	catalogFile  = "web/src/avatar/catalog.gen.ts"
	swatchFile   = "web/src/avatar/swatches.gen.css"
)

// Atlas columns are dirs × frames; each dir is drawn from a source view.
var (
	avatarDirs = [...]string{"down", "left", "right", "up"}
	dirView    = [...]int{0, 2, 2, 1}
	bob        = [avatarFrames]int{0, 1, 1}
)

// avatarRow is one row of the parts atlas: a layer, or one style of it.
type avatarRow struct {
	name     string
	file     string
	animated bool
	variant  int
	// roles recolor the row; need lists the colors it must use, allow
	// every color it may.
	roles       []avatar.Field
	need, allow []string
}

func avatarRows(cats []avatar.Category) []avatarRow {
	keys := func(f avatar.Field) []string { return cats[f].Keys() }
	with := func(a []string, b ...string) []string { return append(slices.Clone(a), b...) }
	rows := []avatarRow{
		{name: "body", file: "body", animated: true, roles: []avatar.Field{avatar.Skin},
			need: keys(avatar.Skin), allow: with(keys(avatar.Skin), avatar.Outline, avatar.Eyes, avatar.Shadow)},
		{name: "pants", file: "pants", animated: true, roles: []avatar.Field{avatar.Pants},
			need: keys(avatar.Pants), allow: with(keys(avatar.Pants), avatar.Outline, avatar.Shoe, avatar.Sole)},
		{name: "shirt", file: "shirt", animated: true, roles: []avatar.Field{avatar.Shirt, avatar.Skin},
			need: keys(avatar.Shirt), allow: with(keys(avatar.Shirt), with(keys(avatar.Skin), avatar.Outline)...)},
	}
	for i, o := range cats[avatar.Hair].Options {
		rows = append(rows, avatarRow{name: "hair " + o.Label, file: "hair", variant: i, roles: []avatar.Field{avatar.HairColor},
			need: keys(avatar.HairColor), allow: with(keys(avatar.HairColor), avatar.Outline)})
	}
	for i, o := range cats[avatar.Acc].Options[1:] {
		rows = append(rows, avatarRow{name: "acc " + o.Label, file: "acc", variant: i,
			need: o.Colors, allow: with(o.Colors, avatar.Outline)})
	}
	return rows
}

// rowIndex returns the atlas rows of the hair styles and the accessories;
// accessory 0, none, has no row.
func rowIndex(cats []avatar.Category) (hair, acc []int) {
	for i := range cats[avatar.Hair].Options {
		hair = append(hair, 3+i)
	}
	acc = []int{-1}
	for i := range cats[avatar.Acc].Options[1:] {
		acc = append(acc, 3+len(hair)+i)
	}
	return hair, acc
}

// checkKeys fails when two recolored categories share a key, a fixed color
// is a key, or an option has another number of colors than the keys.
func checkKeys(cats []avatar.Category) error {
	var errs []error
	owner := make(map[string]avatar.Field)
	for _, c := range cats {
		for i, o := range c.Options {
			if c.Recolor && len(o.Colors) != len(c.Keys()) {
				errs = append(errs, fmt.Errorf("%s %q has %d colors, want %d", c.Field, o.Label, len(o.Colors), len(c.Keys())))
			}
			if c.Recolor && i > 0 && slices.Equal(o.Colors, c.Keys()) {
				errs = append(errs, fmt.Errorf("%s %q repeats the keys", c.Field, o.Label))
			}
		}
		for _, k := range c.Keys() {
			if f, ok := owner[k]; ok {
				errs = append(errs, fmt.Errorf("key %s of %s is also a key of %s", k, c.Field, f))
			}
			owner[k] = c.Field
		}
	}
	fixed := []string{avatar.Outline, avatar.Eyes, avatar.Shoe, avatar.Sole, avatar.Shadow}
	for _, o := range cats[avatar.Acc].Options {
		fixed = append(fixed, o.Colors...)
	}
	for _, c := range fixed {
		if f, ok := owner[c]; ok {
			errs = append(errs, fmt.Errorf("fixed color %s is a key of %s", c, f))
		}
	}
	return errors.Join(errs...)
}

func colorHex(c color.NRGBA) string {
	if c.A == 255 {
		return fmt.Sprintf("%02x%02x%02x", c.R, c.G, c.B)
	}
	return fmt.Sprintf("%02x%02x%02x%02x", c.R, c.G, c.B, c.A)
}

func loadAvatarArt(root string) (map[string]image.Image, error) {
	srcs := make(map[string]image.Image)
	for _, name := range []string{"body", "pants", "shirt", "hair", "acc"} {
		path := filepath.Join(root, avatarDir, name+".txt")
		b, err := os.ReadFile(path)
		if err != nil {
			return nil, err
		}
		img, err := parseSprite(b)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", path, err)
		}
		srcs[name] = img
	}
	return srcs, nil
}

// region returns where the row is drawn in its source.
func (r avatarRow) region() image.Rectangle {
	if r.animated {
		return image.Rect(0, 0, avatarFrames*avatarW, 3*avatarH)
	}
	return image.Rect(0, r.variant*avatarH, 3*avatarW, (r.variant+1)*avatarH)
}

// checkSources fails when a source has the wrong size, a row uses a color
// it may not or misses one it must, or a bobbed row would lose its bottom.
func checkSources(rows []avatarRow, srcs map[string]image.Image) error {
	want := make(map[string]image.Point)
	for _, r := range rows {
		want[r.file] = image.Pt(3*avatarW, max(want[r.file].Y, r.region().Max.Y))
	}
	var errs []error
	for file, size := range want {
		img, ok := srcs[file]
		if !ok {
			return fmt.Errorf("%s/%s.txt is missing", avatarDir, file)
		}
		if got := img.Bounds().Size(); got != size {
			errs = append(errs, fmt.Errorf("%s/%s.txt is %dx%d, want %dx%d in frames of %dx%d",
				avatarDir, file, got.X, got.Y, size.X, size.Y, avatarW, avatarH))
		}
	}
	if len(errs) > 0 {
		return errors.Join(errs...)
	}
	for _, r := range rows {
		img := srcs[r.file]
		reg := r.region().Add(img.Bounds().Min)
		used := make(map[string]bool)
		for y := reg.Min.Y; y < reg.Max.Y; y++ {
			for x := reg.Min.X; x < reg.Max.X; x++ {
				c := color.NRGBAModel.Convert(img.At(x, y)).(color.NRGBA)
				if c.A == 0 {
					continue
				}
				h := colorHex(c)
				if !slices.Contains(r.allow, h) {
					errs = append(errs, fmt.Errorf("%s/%s.txt: %s pixel %d,%d: color %s is not one of %s",
						avatarDir, r.file, r.name, x, y, h, strings.Join(r.allow, " ")))
					continue
				}
				used[h] = true
				if !r.animated && y == reg.Max.Y-1 {
					errs = append(errs, fmt.Errorf("%s/%s.txt: %s pixel %d,%d: the last row must be empty, the bob moves it out",
						avatarDir, r.file, r.name, x, y))
				}
			}
		}
		for _, c := range r.need {
			if !used[c] {
				errs = append(errs, fmt.Errorf("%s/%s.txt: %s does not use %s", avatarDir, r.file, r.name, c))
			}
		}
	}
	return errors.Join(errs...)
}

// avatarFrame cuts the frame of row r for atlas direction dir.
func avatarFrame(src image.Image, r avatarRow, dir, frame int) *image.NRGBA {
	view := dirView[dir]
	var at image.Point
	dy := 0
	if r.animated {
		at = image.Pt(frame*avatarW, view*avatarH)
	} else {
		at = image.Pt(view*avatarW, r.variant*avatarH)
		dy = bob[frame]
	}
	at = at.Add(src.Bounds().Min)
	out := image.NewNRGBA(image.Rect(0, 0, avatarW, avatarH))
	for y := dy; y < avatarH; y++ {
		for x := range avatarW {
			sx := x
			if avatarDirs[dir] == "left" {
				sx = avatarW - 1 - x
			}
			out.Set(x, y, src.At(at.X+sx, at.Y+y-dy))
		}
	}
	return out
}

func buildParts(cats []avatar.Category, srcs map[string]image.Image) (*image.NRGBA, error) {
	if err := checkKeys(cats); err != nil {
		return nil, err
	}
	rows := avatarRows(cats)
	if err := checkSources(rows, srcs); err != nil {
		return nil, err
	}
	cols := len(avatarDirs) * avatarFrames
	parts := image.NewNRGBA(image.Rect(0, 0, cols*avatarW, len(rows)*avatarH))
	for i, r := range rows {
		for d := range avatarDirs {
			for f := range avatarFrames {
				at := image.Pt((d*avatarFrames+f)*avatarW, i*avatarH)
				draw.Draw(parts, image.Rectangle{at, at.Add(image.Pt(avatarW, avatarH))}, avatarFrame(srcs[r.file], r, d, f), image.Point{}, draw.Src)
			}
		}
	}
	return parts, nil
}

type avatarOutput struct {
	cats  []avatar.Category
	Parts *image.NRGBA
	PNG   []byte
	TS    []byte
	CSS   []byte
}

func generateAvatars(root string) (*avatarOutput, error) {
	srcs, err := loadAvatarArt(root)
	if err != nil {
		return nil, err
	}
	cats := avatar.Categories()
	parts, err := buildParts(cats, srcs)
	if err != nil {
		return nil, err
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, parts); err != nil {
		return nil, err
	}
	return &avatarOutput{cats: cats, Parts: parts, PNG: buf.Bytes(), TS: catalogTS(cats), CSS: swatchCSS(cats)}, nil
}

func (o *avatarOutput) write(root string) error {
	for path, b := range map[string][]byte{partsFile: o.PNG, catalogFile: o.TS, swatchFile: o.CSS} {
		path = filepath.Join(root, path)
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			return err
		}
		if err := os.WriteFile(path, b, 0o644); err != nil {
			return err
		}
	}
	return nil
}

const generated = "Code generated by tools/officeart from internal/avatar; DO NOT EDIT."

func tsString(s string) string {
	return "'" + strings.NewReplacer(`\`, `\\`, `'`, `\'`).Replace(s) + "'"
}

func tsList(items []string, quote bool) string {
	out := make([]string, len(items))
	for i, s := range items {
		out[i] = s
		if quote {
			out[i] = tsString(s)
		}
	}
	return "[" + strings.Join(out, ", ") + "]"
}

func catalogTS(cats []avatar.Category) []byte {
	var b bytes.Buffer
	p := func(format string, args ...any) { fmt.Fprintf(&b, format+"\n", args...) }
	hair, acc := rowIndex(cats)
	num := func(v []int) []string {
		out := make([]string, len(v))
		for i, n := range v {
			out[i] = fmt.Sprint(n)
			if n < 0 {
				out[i] = "null"
			}
		}
		return out
	}
	var fields []string
	for _, c := range cats {
		fields = append(fields, c.Field.String())
	}

	p("// %s", generated)
	p("")
	p("export const FRAME_WIDTH = %d", avatarW)
	p("export const FRAME_HEIGHT = %d", avatarH)
	p("")
	p("// Columns of avatar-parts.png: each direction has the frames idle, step A, step B.")
	p("export const DIRECTIONS = %s as const", tsList(avatarDirs[:], true))
	p("export const FRAMES_PER_DIRECTION = %d", avatarFrames)
	p("")
	p("// Rows of avatar-parts.png, by layer; hair and acc by option (acc 0 has none).")
	p("export const ROWS = {")
	p("  body: 0,")
	p("  pants: 1,")
	p("  shirt: 2,")
	p("  hair: %s,", tsList(num(hair), false))
	p("  acc: %s,", tsList(num(acc), false))
	p("} as const")
	p("")
	quoted := make([]string, len(fields))
	for i, f := range fields {
		quoted[i] = tsString(f)
	}
	p("export type Field = %s", strings.Join(quoted, " | "))
	p("")
	p("export const FIELDS: readonly Field[] = %s", tsList(fields, true))
	p("")
	p("export interface Option {")
	p("  readonly label: string")
	p("  readonly colors: readonly string[]")
	p("}")
	p("")
	p("// A recolored category is drawn in the colors of its first option, its")
	p("// keys; each option swaps them for its own, position by position.")
	p("export interface Category {")
	p("  readonly field: Field")
	p("  readonly label: string")
	p("  readonly recolor: boolean")
	p("  readonly options: readonly Option[]")
	p("}")
	p("")
	p("export const CATEGORIES: readonly Category[] = [")
	for _, c := range cats {
		p("  {")
		p("    field: %s,", tsString(c.Field.String()))
		p("    label: %s,", tsString(c.Label))
		p("    recolor: %t,", c.Recolor)
		p("    options: [")
		for _, o := range c.Options {
			p("      { label: %s, colors: %s },", tsString(o.Label), tsList(o.Colors, true))
		}
		p("    ],")
		p("  },")
	}
	p("]")
	p("")
	p("// Categories each layer is recolored with.")
	p("export const LAYER_RECOLORS: Readonly<Record<keyof typeof ROWS, readonly Field[]>> = {")
	var seen []string
	for _, r := range avatarRows(cats) {
		if slices.Contains(seen, r.file) {
			continue
		}
		seen = append(seen, r.file)
		roles := make([]string, len(r.roles))
		for i, f := range r.roles {
			roles[i] = f.String()
		}
		p("  %s: %s,", r.file, tsList(roles, true))
	}
	p("}")
	return b.Bytes()
}

// swatch returns the color that stands for a palette: its base.
func swatch(o avatar.Option) string { return o.Colors[(len(o.Colors)-1)/2] }

func swatchCSS(cats []avatar.Category) []byte {
	var b bytes.Buffer
	fmt.Fprintf(&b, "/* %s */\n", generated)
	for _, c := range cats {
		if !c.Recolor {
			continue
		}
		for i, o := range c.Options {
			fmt.Fprintf(&b, ".swatch-%s-%d { --swatch: #%s; }\n", c.Field, i, swatch(o))
		}
	}
	return b.Bytes()
}

// composeAvatar draws a facing atlas direction dir at frame, recoloring
// each layer of the parts atlas as the client does.
func composeAvatar(parts *image.NRGBA, cats []avatar.Category, a avatar.Appearance, dir, frame int) *image.NRGBA {
	rows := avatarRows(cats)
	hair, acc := rowIndex(cats)
	layers := []int{0, 1, 2, hair[a.Hair]}
	if a.Acc > 0 {
		layers = append(layers, acc[a.Acc])
	}
	v := a.Fields()
	out := image.NewNRGBA(image.Rect(0, 0, avatarW, avatarH))
	for _, row := range layers {
		swap := make(map[color.NRGBA]color.NRGBA)
		for _, f := range rows[row].roles {
			to := cats[f].Options[v[f]].Colors
			for i, k := range cats[f].Keys() {
				from, _ := hexColor(k)
				swap[from], _ = hexColor(to[i])
			}
		}
		layer := image.NewNRGBA(out.Bounds())
		at := image.Pt((dir*avatarFrames+frame)*avatarW, row*avatarH)
		for y := range avatarH {
			for x := range avatarW {
				c := parts.NRGBAAt(at.X+x, at.Y+y)
				if to, ok := swap[c]; ok {
					c = to
				}
				layer.SetNRGBA(x, y, c)
			}
		}
		draw.Draw(out, out.Bounds(), layer, image.Point{}, draw.Over)
	}
	return out
}

// reviewLooks cover every option of every category.
var reviewLooks = []avatar.Appearance{
	{Skin: 0, Hair: 0, HairColor: 0, Shirt: 0, Pants: 0, Acc: 0},
	{Skin: 1, Hair: 1, HairColor: 2, Shirt: 1, Pants: 1, Acc: 1},
	{Skin: 2, Hair: 2, HairColor: 1, Shirt: 2, Pants: 2, Acc: 0},
	{Skin: 3, Hair: 3, HairColor: 3, Shirt: 3, Pants: 3, Acc: 2},
	{Skin: 4, Hair: 4, HairColor: 4, Shirt: 4, Pants: 0, Acc: 0},
	{Skin: 2, Hair: 5, HairColor: 6, Shirt: 5, Pants: 1, Acc: 0},
	{Skin: 0, Hair: 3, HairColor: 5, Shirt: 6, Pants: 2, Acc: 0},
	{Skin: 3, Hair: 0, HairColor: 7, Shirt: 7, Pants: 3, Acc: 1},
	{Skin: 4, Hair: 2, HairColor: 0, Shirt: 1, Pants: 1, Acc: 3},
	{Skin: 1, Hair: 4, HairColor: 3, Shirt: 2, Pants: 0, Acc: 2},
}

var (
	floorLight = color.NRGBA{0xc8, 0xca, 0xd5, 0xff}
	floorBlue  = color.NRGBA{0x3a, 0x6c, 0x9f, 0xff}
)

// writeAvatarSheets writes avatars.png, every review look in the four
// directions and three frames at 4×, on the light floor and the blue
// carpet; avatar-parts.png, the parts atlas at 4×; and avatars.gif, some
// looks walking in the four directions.
func writeAvatarSheets(dir string, o *avatarOutput) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	const (
		zoom   = 4
		labelW = 120
		gap    = 4
		dirGap = 20
		fw     = avatarW * zoom
		fh     = avatarH * zoom
	)
	groupW := avatarFrames*(fw+gap) + dirGap
	sheet := image.NewNRGBA(image.Rect(0, 0, labelW+len(avatarDirs)*groupW, len(reviewLooks)*(fh+gap)))
	for i, a := range reviewLooks {
		bg := floorLight
		if i%2 == 1 {
			bg = floorBlue
		}
		y := i * (fh + gap)
		draw.Draw(sheet, image.Rect(0, y, sheet.Bounds().Dx(), y+fh+gap), image.NewUniform(bg), image.Point{}, draw.Src)
		label(sheet, 8, y+fh/2-5, 2, a.String(), color.NRGBA{0x26, 0x29, 0x2e, 0xff})
		for d := range avatarDirs {
			for f := range avatarFrames {
				x := labelW + d*groupW + f*(fw+gap)
				img := scaled(composeAvatar(o.Parts, o.cats, a, d, f), zoom)
				draw.Draw(sheet, image.Rect(x, y+gap/2, x+fw, y+gap/2+fh), img, image.Point{}, draw.Over)
			}
		}
	}
	if err := writePNG(filepath.Join(dir, "avatars.png"), sheet); err != nil {
		return err
	}

	b := o.Parts.Bounds()
	atlas := image.NewNRGBA(image.Rect(0, 0, b.Dx()*zoom, b.Dy()*zoom))
	for y := range atlas.Bounds().Dy() {
		for x := range atlas.Bounds().Dx() {
			c := color.NRGBA{0xcd, 0xcd, 0xcd, 0xff}
			if (x/8+y/8)%2 == 0 {
				c = color.NRGBA{0xeb, 0xeb, 0xeb, 0xff}
			}
			atlas.SetNRGBA(x, y, c)
		}
	}
	draw.Draw(atlas, atlas.Bounds(), scaled(o.Parts, zoom), image.Point{}, draw.Over)
	if err := writePNG(filepath.Join(dir, "avatar-parts.png"), atlas); err != nil {
		return err
	}
	return writeAvatarGIF(filepath.Join(dir, "avatars.gif"), o)
}

func writeAvatarGIF(path string, o *avatarOutput) error {
	const (
		zoom  = 4
		cellW = 24 * zoom
		cellH = 28 * zoom
		delay = 8
	)
	looks := reviewLooks[:6]
	walk := []int{1, 0, 2, 0}
	var frames []*image.NRGBA
	var delays []int
	for _, d := range []int{0, 2, 3, 1} {
		for step := range 2 * len(walk) {
			img := image.NewNRGBA(image.Rect(0, 0, len(looks)*cellW, cellH))
			draw.Draw(img, img.Bounds(), image.NewUniform(floorLight), image.Point{}, draw.Src)
			for i, a := range looks {
				av := scaled(composeAvatar(o.Parts, o.cats, a, d, walk[step%len(walk)]), zoom)
				x, y := i*cellW+(cellW-avatarW*zoom)/2, (cellH-avatarH*zoom)/2
				draw.Draw(img, image.Rect(x, y, x+avatarW*zoom, y+avatarH*zoom), av, image.Point{}, draw.Over)
			}
			frames = append(frames, img)
			delays = append(delays, delay)
		}
	}
	index := make(map[color.NRGBA]uint8)
	var pal color.Palette
	anim := &gif.GIF{Delay: delays}
	for _, f := range frames {
		p := image.NewPaletted(f.Bounds(), nil)
		for y := range f.Bounds().Dy() {
			for x := range f.Bounds().Dx() {
				c := f.NRGBAAt(x, y)
				i, ok := index[c]
				if !ok {
					if len(pal) == 256 {
						return errors.New("avatars.gif: more than 256 colors")
					}
					i = uint8(len(pal))
					index[c] = i
					pal = append(pal, c)
				}
				p.Pix[y*p.Stride+x] = i
			}
		}
		anim.Image = append(anim.Image, p)
	}
	for _, p := range anim.Image {
		p.Palette = pal
	}
	var buf bytes.Buffer
	if err := gif.EncodeAll(&buf, anim); err != nil {
		return err
	}
	return os.WriteFile(path, buf.Bytes(), 0o644)
}
