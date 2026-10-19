package main

import (
	"bytes"
	"image"
	"image/color"
	"image/draw"
	"image/png"
	"maps"
	"os"
	"strings"
	"testing"

	"github.com/victoroliveirabarros/vb-office-32/internal/avatar"
)

// TestAvatarGolden fails when the committed avatar parts, catalog or
// swatches differ from what the generator makes now: run `make art`.
func TestAvatarGolden(t *testing.T) {
	o, err := generateAvatars(root)
	if err != nil {
		t.Fatal(err)
	}
	if b := o.Parts.Bounds(); b.Dx() != 192 || b.Dy() != 312 {
		t.Errorf("parts are %dx%d, want 192x312", b.Dx(), b.Dy())
	}
	f, err := os.Open(root + "/" + partsFile)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	img, err := png.Decode(f)
	if err != nil {
		t.Fatal(err)
	}
	if !samePixels(img, o.Parts) {
		t.Errorf("%s is out of date: run make art", partsFile)
	}
	for path, want := range map[string][]byte{catalogFile: o.TS, swatchFile: o.CSS} {
		got, err := os.ReadFile(root + "/" + path)
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(got, want) {
			t.Errorf("%s is out of date: run make art", path)
		}
	}
}

func TestAvatarFrames(t *testing.T) {
	o, err := generateAvatars(root)
	if err != nil {
		t.Fatal(err)
	}
	frame := func(row, dir, f int) *image.NRGBA {
		r := image.Rect(0, 0, avatarW, avatarH).Add(image.Pt((dir*avatarFrames+f)*avatarW, row*avatarH))
		return o.Parts.SubImage(r).(*image.NRGBA)
	}
	at := func(img *image.NRGBA, x, y int) color.NRGBA {
		return img.NRGBAAt(img.Rect.Min.X+x, img.Rect.Min.Y+y)
	}
	rows := avatarRows(o.cats)
	for i, r := range rows {
		for f := range avatarFrames {
			left, right := frame(i, 1, f), frame(i, 2, f)
			for y := range avatarH {
				for x := range avatarW {
					if at(left, x, y) != at(right, avatarW-1-x, y) {
						t.Fatalf("%s frame %d: left %d,%d does not mirror right", r.name, f, x, y)
					}
				}
			}
			if r.animated {
				continue
			}
			for d := range avatarDirs {
				idle, step := frame(i, d, 0), frame(i, d, f)
				for y := range avatarH {
					for x := range avatarW {
						want := color.NRGBA{}
						if y >= bob[f] {
							want = at(idle, x, y-bob[f])
						}
						if at(step, x, y) != want {
							t.Fatalf("%s %s frame %d: pixel %d,%d is not the idle one moved %d px", r.name, avatarDirs[d], f, x, y, bob[f])
						}
					}
				}
			}
		}
	}
	if at(frame(1, 0, 0), 4, avatarH-1) == (color.NRGBA{}) {
		t.Error("the idle feet do not stand on the bottom row")
	}
	a := composeAvatar(o.Parts, o.cats, avatar.Appearance{Skin: 4, Shirt: 1}, 0, 0)
	skin, _ := hexColor(o.cats[avatar.Skin].Options[4].Colors[1])
	key, _ := hexColor(o.cats[avatar.Skin].Keys()[1])
	var found bool
	for y := range avatarH {
		for x := range avatarW {
			c := a.NRGBAAt(x, y)
			found = found || c == skin
			if c == key {
				t.Fatalf("pixel %d,%d keeps the skin key", x, y)
			}
		}
	}
	if !found {
		t.Error("composed avatar has no recolored skin")
	}

	// Bald shows no hair color, and the scalp shines over the skin in
	// every direction.
	hairColors := make(map[color.NRGBA]bool)
	for _, opt := range o.cats[avatar.HairColor].Options {
		for _, h := range opt.Colors {
			c, _ := hexColor(h)
			hairColors[c] = true
		}
	}
	head := map[color.NRGBA]bool{{}: true}
	for _, h := range append(o.cats[avatar.Skin].Options[2].Colors, avatar.Outline) {
		c, _ := hexColor(h)
		head[c] = true
	}
	for d := range avatarDirs {
		for f := range avatarFrames {
			a := composeAvatar(o.Parts, o.cats, avatar.Appearance{Skin: 2, Hair: avatar.Bald, HairColor: 3}, d, f)
			shine := false
			for y := range avatarH {
				for x := range avatarW {
					c := a.NRGBAAt(x, y)
					if hairColors[c] {
						t.Fatalf("bald %s frame %d: pixel %d,%d has a hair color", avatarDirs[d], f, x, y)
					}
					shine = shine || y < 5 && !head[c]
				}
			}
			if !shine {
				t.Errorf("bald %s frame %d: the scalp does not shine", avatarDirs[d], f)
			}
		}
	}
}

func cloneImage(img image.Image) *image.NRGBA {
	out := image.NewNRGBA(img.Bounds())
	draw.Draw(out, out.Bounds(), img, img.Bounds().Min, draw.Src)
	return out
}

func TestAvatarErrors(t *testing.T) {
	base, err := loadAvatarArt(root)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := buildParts(avatar.Categories(), base); err != nil {
		t.Fatal(err)
	}
	replace := func(img *image.NRGBA, from, to string) {
		f, _ := hexColor(from)
		c, _ := hexColor(to)
		b := img.Bounds()
		for y := b.Min.Y; y < b.Max.Y; y++ {
			for x := b.Min.X; x < b.Max.X; x++ {
				if img.NRGBAAt(x, y) == f {
					img.SetNRGBA(x, y, c)
				}
			}
		}
	}
	tests := []struct {
		name string
		edit func(cats []avatar.Category, srcs map[string]image.Image)
		want string
	}{
		{"color outside keys and fixed", func(_ []avatar.Category, s map[string]image.Image) {
			img := cloneImage(s["body"])
			img.SetNRGBA(5, 5, color.NRGBA{0x12, 0x34, 0x56, 0xff})
			s["body"] = img
		}, "color 123456 is not one of"},
		{"other layer's key", func(_ []avatar.Category, s map[string]image.Image) {
			img := cloneImage(s["hair"])
			img.SetNRGBA(5, 2, color.NRGBA{0x3f, 0x62, 0x86, 0xff})
			s["hair"] = img
		}, "hair Curto pixel 5,2: color 3f6286"},
		{"accessory color on another accessory", func(_ []avatar.Category, s map[string]image.Image) {
			img := cloneImage(s["acc"])
			img.SetNRGBA(5, 24+1, color.NRGBA{0xcf, 0xe3, 0xf2, 0xff})
			s["acc"] = img
		}, "acc Fone pixel 5,25: color cfe3f2"},
		{"unused key", func(_ []avatar.Category, s map[string]image.Image) {
			img := cloneImage(s["body"])
			replace(img, "f7d7bc", "edbe9a")
			s["body"] = img
		}, "body does not use f7d7bc"},
		{"unused key in one style", func(_ []avatar.Category, s map[string]image.Image) {
			img := cloneImage(s["hair"])
			sub := img.SubImage(image.Rect(0, 3*avatarH, 3*avatarW, 4*avatarH)).(*image.NRGBA)
			replace(sub, "1c1b1f", "2f2d33")
			s["hair"] = img
		}, "hair Longo does not use 1c1b1f"},
		{"hair color on the bald style", func(_ []avatar.Category, s map[string]image.Image) {
			img := cloneImage(s["hair"])
			img.SetNRGBA(7, int(avatar.Bald)*avatarH+3, color.NRGBA{0x4a, 0x48, 0x50, 0xff})
			s["hair"] = img
		}, "hair Careca pixel 7,147: color 4a4850 is not one of " + avatar.ScalpShine},
		{"bald style without its shine", func(_ []avatar.Category, s map[string]image.Image) {
			img := cloneImage(s["hair"])
			draw.Draw(img, image.Rect(0, int(avatar.Bald)*avatarH, 3*avatarW, int(avatar.Bald+1)*avatarH), image.Transparent, image.Point{}, draw.Src)
			s["hair"] = img
		}, "hair Careca does not use " + avatar.ScalpShine},
		{"only the bald style may go without hair", func(_ []avatar.Category, s map[string]image.Image) {
			img := cloneImage(s["hair"])
			draw.Draw(img, image.Rect(0, 0, 3*avatarW, avatarH), image.Transparent, image.Point{}, draw.Src)
			s["hair"] = img
		}, "hair Curto does not use 4a4850"},
		{"the shine only on the bald style", func(_ []avatar.Category, s map[string]image.Image) {
			img := cloneImage(s["hair"])
			c, _ := hexColor(avatar.ScalpShine)
			img.SetNRGBA(5, 2, c)
			s["hair"] = img
		}, "hair Curto pixel 5,2: color " + avatar.ScalpShine + " is not one of"},
		{"bob moves pixels out", func(_ []avatar.Category, s map[string]image.Image) {
			img := cloneImage(s["hair"])
			img.SetNRGBA(3, avatarH-1, color.NRGBA{0x26, 0x29, 0x2e, 0xff})
			s["hair"] = img
		}, "hair Curto pixel 3,23: the last row must be empty"},
		{"wrong size", func(_ []avatar.Category, s map[string]image.Image) {
			s["hair"] = cloneImage(s["hair"]).SubImage(image.Rect(0, 0, 3*avatarW, 5*avatarH))
		}, "hair.txt is 48x120, want 48x168"},
		{"wrong frame width", func(_ []avatar.Category, s map[string]image.Image) {
			s["body"] = cloneImage(s["body"]).SubImage(image.Rect(0, 0, 3*avatarW-1, 3*avatarH))
		}, "body.txt is 47x72, want 48x72"},
		{"missing layer", func(_ []avatar.Category, s map[string]image.Image) {
			delete(s, "acc")
		}, "acc.txt is missing"},
		{"repeated key", func(c []avatar.Category, _ map[string]image.Image) {
			c[avatar.Pants].Options[0].Colors[0] = "f7d7bc"
		}, "key f7d7bc of pants is also a key of skin"},
		{"fixed color as key", func(c []avatar.Category, _ map[string]image.Image) {
			c[avatar.Shirt].Options[0].Colors[2] = avatar.Shoe
		}, "fixed color 3a3f4b is a key of shirt"},
		{"short palette", func(c []avatar.Category, _ map[string]image.Image) {
			c[avatar.Skin].Options[2].Colors = c[avatar.Skin].Options[2].Colors[:2]
		}, `skin "Tom 3" has 2 colors, want 3`},
		{"palette equal to the keys", func(c []avatar.Category, _ map[string]image.Image) {
			c[avatar.HairColor].Options[3].Colors = c[avatar.HairColor].Keys()
		}, `hairColor "Ruivo" repeats the keys`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cats := avatar.Categories()
			srcs := maps.Clone(base)
			tt.edit(cats, srcs)
			_, err := buildParts(cats, srcs)
			if err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("buildParts = %v, want an error with %q", err, tt.want)
			}
		})
	}
}

func TestCatalogTS(t *testing.T) {
	cats := avatar.Categories()
	ts := string(catalogTS(cats))
	for _, want := range []string{
		"export const FRAME_HEIGHT = 24\n",
		"  hair: [3, 4, 5, 6, 7, 8, 9],\n",
		"  acc: [null, 10, 11, 12],\n",
		"export const BALD = 6\n",
		"      { label: 'Cáqui', colors: ['c4ae82', '9e8a62'] },\n",
		"  shirt: ['shirt', 'skin'],\n",
	} {
		if !strings.Contains(ts, want) {
			t.Errorf("catalog.gen.ts lacks %q", want)
		}
	}
	if got := tsString(`it's \ ok`); got != `'it\'s \\ ok'` {
		t.Errorf("tsString = %s", got)
	}
	css := string(swatchCSS(cats))
	for _, want := range []string{
		".swatch-skin-0 { --swatch: #edbe9a; }\n",
		".swatch-hairColor-7 { --swatch: #2f5d8a; }\n",
		".swatch-pants-2 { --swatch: #c4ae82; }\n",
	} {
		if !strings.Contains(css, want) {
			t.Errorf("swatches.gen.css lacks %q", want)
		}
	}
	if strings.Contains(css, "swatch-hair-") || strings.Contains(css, "swatch-acc-") {
		t.Error("swatches for styles")
	}
}
