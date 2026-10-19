// Package avatar is the catalog of avatar looks: which values each field of
// an Appearance may take, the colors the art is recolored with and the
// default look of a player. The catalog only grows: options are appended at
// the end of a list, never removed or reordered, so a saved Appearance keeps
// its meaning.
package avatar

import (
	"errors"
	"fmt"
	"hash/fnv"
	"slices"
	"strconv"
	"strings"
)

// Appearance picks one option of each category. The zero value is valid.
type Appearance struct {
	Skin      uint8 `json:"skin"`
	Hair      uint8 `json:"hair"`
	HairColor uint8 `json:"hairColor"`
	Shirt     uint8 `json:"shirt"`
	Pants     uint8 `json:"pants"`
	Acc       uint8 `json:"acc"`
}

// Field names a field of Appearance; fields are numbered in the order of
// the struct and of the compact form.
type Field int

const (
	Skin Field = iota
	Hair
	HairColor
	Shirt
	Pants
	Acc
)

// NumFields is the number of fields of an Appearance.
const NumFields = 6

var fieldNames = [NumFields]string{"skin", "hair", "hairColor", "shirt", "pants", "acc"}

// String returns the field's JSON name.
func (f Field) String() string {
	if f < 0 || f >= NumFields {
		return "Field(" + strconv.Itoa(int(f)) + ")"
	}
	return fieldNames[f]
}

// Colors the art is drawn with besides the keys, as "rrggbb" or "rrggbbaa".
const (
	Outline    = "26292e"
	Eyes       = "26292e"
	EyeShine   = "f5f1ea"
	Shoe       = "3a3f4b"
	Sole       = "26292e"
	Shadow     = "00000040"
	ScalpShine = "ffffff73"
)

// Bald is the hair style without hair: its art has none of the hair color
// keys, only the shine of the scalp, so the hair color does not show.
const Bald uint8 = 6

// Option is one choice of a category. Colors are "rrggbb": for a recolored
// category, its palette from light to dark; for an accessory, the colors it
// is drawn with; none for a hair style.
type Option struct {
	Label  string
	Colors []string
}

// Category lists the options of one field. When Recolor is set the art is
// drawn with the colors of the first option, its keys, and each option
// swaps them for its own colors, position by position.
type Category struct {
	Field   Field
	Label   string
	Recolor bool
	Options []Option
}

// Keys returns the colors the art of a recolored category is drawn with.
func (c Category) Keys() []string {
	if !c.Recolor {
		return nil
	}
	return c.Options[0].Colors
}

// Fixed returns the colors that are never recolored: outline, eyes, shoes,
// shadow, the shine of the bald scalp and the accessories' colors, without
// repeats.
func Fixed() []string {
	var out []string
	add := func(colors ...string) {
		for _, c := range colors {
			if !slices.Contains(out, c) {
				out = append(out, c)
			}
		}
	}
	add(Outline, Eyes, EyeShine, Shoe, Sole, Shadow, ScalpShine)
	for _, o := range catalog[Acc].Options {
		add(o.Colors...)
	}
	return out
}

func opt(label string, colors ...string) Option { return Option{label, colors} }

var catalog = [NumFields]Category{
	{Skin, "Pele", true, []Option{
		opt("Tom 1", "f7d7bc", "edbe9a", "d29a76"),
		opt("Tom 2", "eec08f", "dca06f", "bb7f53"),
		opt("Tom 3", "cf9564", "b67a4a", "935e36"),
		opt("Tom 4", "9e6843", "845332", "663e25"),
		opt("Tom 5", "6e452b", "583621", "402617"),
	}},
	{Hair, "Cabelo", false, []Option{
		opt("Curto"), opt("Topete"), opt("Cacheado"), opt("Longo"), opt("Coque"), opt("Raspado"), opt("Careca"),
	}},
	{HairColor, "Cor do cabelo", true, []Option{
		opt("Preto", "4a4850", "2f2d33", "1c1b1f"),
		opt("Castanho-escuro", "6e4a35", "4e3325", "352219"),
		opt("Castanho", "a06a40", "7e4f2d", "5b371f"),
		opt("Ruivo", "de7a43", "b9552e", "8c3d20"),
		opt("Loiro-escuro", "ddb86a", "c29848", "9a7534"),
		opt("Loiro", "f7e6a6", "e8cf7a", "c4aa58"),
		opt("Grisalho", "d2d4d8", "a9acb2", "7f838a"),
		opt("Azul", "5a8fc4", "2f5d8a", "1f3f60"),
	}},
	{Shirt, "Camisa", true, []Option{
		opt("Marinho", "3f6286", "1f3c5a", "152b42"),
		opt("Amarelo", "ffd766", "fdc339", "d9a21f"),
		opt("Branco", "ffffff", "eef0f3", "c5cbd5"),
		opt("Cinza", "b5bcc8", "8d97a8", "6b7486"),
		opt("Vermelho", "e07f72", "c4473b", "98342b"),
		opt("Verde", "6db27c", "3e8a52", "2a6139"),
		opt("Azul-claro", "9acdf6", "5aa9f0", "3b86ca"),
		opt("Roxo", "a57ad0", "7a3fb0", "5a2c85"),
	}},
	{Pants, "Calça", true, []Option{
		opt("Jeans", "4a6a99", "344e75"),
		opt("Preta", "3d4048", "2a2c32"),
		opt("Cáqui", "c4ae82", "9e8a62"),
		opt("Cinza", "7a8191", "5b6170"),
	}},
	{Acc, "Acessório", false, []Option{
		opt("Nenhum"),
		opt("Óculos", "26292e", "cfe3f2"),
		opt("Fone", "33363d", "f2b632"),
		opt("Boné", "213f5e", "16304a", "fdc339"),
	}},
}

// Categories returns a copy of the catalog in field order.
func Categories() []Category {
	out := make([]Category, NumFields)
	for i, c := range catalog {
		opts := make([]Option, len(c.Options))
		for j, o := range c.Options {
			opts[j] = Option{o.Label, append([]string(nil), o.Colors...)}
		}
		c.Options = opts
		out[i] = c
	}
	return out
}

// Count returns how many options field f has.
func Count(f Field) int {
	if f < 0 || f >= NumFields {
		return 0
	}
	return len(catalog[f].Options)
}

// Fields returns the values of a in field order.
func (a Appearance) Fields() [NumFields]uint8 {
	return [NumFields]uint8{a.Skin, a.Hair, a.HairColor, a.Shirt, a.Pants, a.Acc}
}

// FromFields is the inverse of Appearance.Fields.
func FromFields(v [NumFields]uint8) Appearance {
	return Appearance{v[0], v[1], v[2], v[3], v[4], v[5]}
}

// Valid reports whether every field of a names an option of the catalog.
func (a Appearance) Valid() bool {
	for f, v := range a.Fields() {
		if int(v) >= Count(Field(f)) {
			return false
		}
	}
	return true
}

// ErrInvalid is wrapped by every error of Parse.
var ErrInvalid = errors.New("invalid appearance")

// String returns the compact form "skin.hair.hairColor.shirt.pants.acc".
func (a Appearance) String() string {
	var b strings.Builder
	for i, v := range a.Fields() {
		if i > 0 {
			b.WriteByte('.')
		}
		b.WriteString(strconv.Itoa(int(v)))
	}
	return b.String()
}

// Parse reads the compact form written by String. Missing trailing fields
// are 0; extra fields, anything but decimal numbers and options outside the
// catalog are errors.
func Parse(s string) (Appearance, error) {
	parts := strings.Split(s, ".")
	if s == "" || len(parts) > NumFields {
		return Appearance{}, fmt.Errorf("%w: %q", ErrInvalid, s)
	}
	var v [NumFields]uint8
	for i, p := range parts {
		n, err := strconv.ParseUint(p, 10, 8)
		if err != nil {
			return Appearance{}, fmt.Errorf("%w: %s %q", ErrInvalid, Field(i), p)
		}
		v[i] = uint8(n)
	}
	a := FromFields(v)
	if !a.Valid() {
		return Appearance{}, fmt.Errorf("%w: %s is outside the catalog", ErrInvalid, s)
	}
	return a, nil
}

// defaultPools are the values Default picks from. They are frozen: growing
// the catalog must not change anyone's default look.
var defaultPools = [NumFields][]uint8{
	{0, 1, 2, 3, 4},
	{0, 1, 2, 3, 4, 5},
	{0, 1, 2, 3, 4, 5, 6},
	{0, 1, 2, 3, 4, 5, 6, 7},
	{0, 1, 2, 3},
	{0, 0, 0, 1},
}

// Default returns the look of a player who has not chosen one: the FNV-1a
// hash of id read as a mixed-radix number, one digit per field.
func Default(id string) Appearance {
	h := fnv.New64a()
	h.Write([]byte(id))
	n := h.Sum64()
	var v [NumFields]uint8
	for f, pool := range defaultPools {
		size := uint64(len(pool))
		v[f] = pool[n%size]
		n /= size
	}
	return FromFields(v)
}
