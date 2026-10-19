package avatar

import (
	"errors"
	"fmt"
	"regexp"
	"slices"
	"testing"
)

func TestCounts(t *testing.T) {
	want := [NumFields]int{5, 6, 8, 8, 4, 4}
	for f := range Field(NumFields) {
		if got := Count(f); got != want[f] {
			t.Errorf("Count(%s) = %d, want %d", f, got, want[f])
		}
	}
	if Count(-1) != 0 || Count(NumFields) != 0 {
		t.Error("Count outside the fields is not 0")
	}
	for i, c := range Categories() {
		if c.Field != Field(i) {
			t.Errorf("category %d is %s", i, c.Field)
		}
	}
}

func TestValid(t *testing.T) {
	tests := []struct {
		a    Appearance
		want bool
	}{
		{Appearance{}, true},
		{Appearance{4, 5, 7, 7, 3, 3}, true},
		{Appearance{Skin: 5}, false},
		{Appearance{Hair: 6}, false},
		{Appearance{HairColor: 8}, false},
		{Appearance{Shirt: 8}, false},
		{Appearance{Pants: 4}, false},
		{Appearance{Acc: 4}, false},
		{Appearance{Acc: 255}, false},
	}
	for _, tt := range tests {
		if got := tt.a.Valid(); got != tt.want {
			t.Errorf("%v.Valid() = %v, want %v", tt.a, got, tt.want)
		}
	}
}

func TestParse(t *testing.T) {
	tests := []struct {
		in   string
		want Appearance
	}{
		{"0.0.0.0.0.0", Appearance{}},
		{"4.5.7.7.3.3", Appearance{4, 5, 7, 7, 3, 3}},
		{"3", Appearance{Skin: 3}},
		{"1.2", Appearance{Skin: 1, Hair: 2}},
		{"1.2.3.4.1", Appearance{1, 2, 3, 4, 1, 0}},
		{"01.2", Appearance{Skin: 1, Hair: 2}},
	}
	for _, tt := range tests {
		got, err := Parse(tt.in)
		if err != nil || got != tt.want {
			t.Errorf("Parse(%q) = %v, %v, want %v", tt.in, got, err, tt.want)
		}
	}
}

func TestParseErrors(t *testing.T) {
	for _, in := range []string{
		"", ".", "1.", ".1", "1..2", "0.0.0.0.0.0.0", "0.0.0.0.0.0.", "-1", "+1", "a", "1.x",
		" 1", "1 ", "0x1", "1_0", "1.5e0", "256", "5", "0.6", "0.0.8", "0.0.0.8", "0.0.0.0.4", "0.0.0.0.0.4",
		"4294967296",
	} {
		a, err := Parse(in)
		if !errors.Is(err, ErrInvalid) {
			t.Errorf("Parse(%q) = %v, %v, want ErrInvalid", in, a, err)
		}
	}
}

func TestStringRoundTrip(t *testing.T) {
	if got := (Appearance{1, 2, 3, 4, 0, 2}).String(); got != "1.2.3.4.0.2" {
		t.Errorf("String = %q", got)
	}
	n := 0
	var v [NumFields]uint8
	var walk func(f int)
	walk = func(f int) {
		if f == NumFields {
			a := FromFields(v)
			if a.Fields() != v {
				t.Fatalf("Fields(FromFields(%v)) = %v", v, a.Fields())
			}
			got, err := Parse(a.String())
			if err != nil || got != a {
				t.Fatalf("Parse(%q) = %v, %v", a.String(), got, err)
			}
			n++
			return
		}
		for i := range Count(Field(f)) {
			v[f] = uint8(i)
			walk(f + 1)
		}
	}
	walk(0)
	if n != 5*6*8*8*4*4 {
		t.Errorf("walked %d appearances", n)
	}
}

func TestDefault(t *testing.T) {
	pinned := []struct {
		id   string
		want Appearance
	}{
		{"", Appearance{2, 3, 3, 5, 2, 0}},
		{"alice", Appearance{3, 4, 3, 3, 2, 0}},
		{"guest-1", Appearance{4, 5, 2, 4, 1, 0}},
		{"sub|1234567890", Appearance{2, 2, 4, 7, 3, 1}},
		{"Victor Barros", Appearance{4, 1, 5, 7, 2, 1}},
	}
	for _, tt := range pinned {
		if got := Default(tt.id); got != tt.want {
			t.Errorf("Default(%q) = %v, want %v", tt.id, got, tt.want)
		}
	}

	var seen [NumFields]map[uint8]bool
	for f := range seen {
		seen[f] = make(map[uint8]bool)
	}
	looks := make(map[Appearance]bool)
	for i := range 1000 {
		id := fmt.Sprintf("player-%d", i)
		a := Default(id)
		if Default(id) != a {
			t.Fatalf("Default(%q) is not stable", id)
		}
		if !a.Valid() {
			t.Fatalf("Default(%q) = %v is invalid", id, a)
		}
		for f, v := range a.Fields() {
			if !slices.Contains(defaultPools[f], v) {
				t.Fatalf("Default(%q).%s = %d is outside its pool", id, Field(f), v)
			}
			seen[f][v] = true
		}
		looks[a] = true
	}
	for f, pool := range defaultPools {
		for _, v := range pool {
			if !seen[f][v] {
				t.Errorf("no default has %s %d", Field(f), v)
			}
		}
	}
	if len(looks) < 900 {
		t.Errorf("1000 ids share %d looks", len(looks))
	}
}

func TestCatalog(t *testing.T) {
	hex := regexp.MustCompile(`^[0-9a-f]{6}([0-9a-f]{2})?$`)
	keys := make(map[string]Field)
	for _, c := range Categories() {
		if c.Label == "" {
			t.Errorf("%s has no label", c.Field)
		}
		labels := make(map[string]bool)
		for i, o := range c.Options {
			if o.Label == "" || labels[o.Label] {
				t.Errorf("%s %d: label %q is empty or repeated", c.Field, i, o.Label)
			}
			labels[o.Label] = true
			for _, col := range o.Colors {
				if !hex.MatchString(col) || len(col) != 6 {
					t.Errorf("%s %d: color %q", c.Field, i, col)
				}
			}
			if c.Recolor && len(o.Colors) != len(c.Keys()) {
				t.Errorf("%s %d has %d colors, want %d", c.Field, i, len(o.Colors), len(c.Keys()))
			}
			if c.Field == Hair && len(o.Colors) != 0 {
				t.Errorf("hair style %d has colors", i)
			}
		}
		if !c.Recolor {
			if c.Keys() != nil {
				t.Errorf("%s has keys", c.Field)
			}
			continue
		}
		if len(c.Keys()) < 2 {
			t.Errorf("%s has %d keys", c.Field, len(c.Keys()))
		}
		for _, k := range c.Keys() {
			if f, ok := keys[k]; ok {
				t.Errorf("key %s of %s is also a key of %s", k, c.Field, f)
			}
			keys[k] = c.Field
		}
	}
	for _, f := range Fixed() {
		if !hex.MatchString(f) {
			t.Errorf("fixed color %q", f)
		}
		if _, ok := keys[f]; ok {
			t.Errorf("fixed color %s is a key", f)
		}
	}
	if fixed := Fixed(); len(slices.Compact(slices.Sorted(slices.Values(fixed)))) != len(fixed) {
		t.Errorf("Fixed repeats colors: %v", fixed)
	}
	for _, f := range []Field{Skin, HairColor, Shirt, Pants} {
		if !Categories()[f].Recolor {
			t.Errorf("%s is not recolored", f)
		}
	}
}

func TestCategoriesIsACopy(t *testing.T) {
	c := Categories()
	c[Skin].Options[0].Colors[0] = "000000"
	c[Skin].Options[0].Label = "x"
	if k := Categories()[Skin].Keys()[0]; k != "f7d7bc" {
		t.Errorf("catalog changed through a copy: key %s", k)
	}
}

func TestFieldString(t *testing.T) {
	if Skin.String() != "skin" || HairColor.String() != "hairColor" || Acc.String() != "acc" || Field(9).String() != "Field(9)" {
		t.Error("Field.String")
	}
}
