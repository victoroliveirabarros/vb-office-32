package main

// Entry names a tile of the atlas. Its index in manifest is its place in the
// atlas, so its gid in the map is that index + 1.
type Entry struct {
	Name string
	Source
}

func rpg(col, row int) Source            { return Source{"rpg", col, row} }
func indoor(col, row int) Source         { return Source{"indoor", col, row} }
func custom(name string, col int) Source { return Source{"custom:" + name, col, 0} }

// nine lists a 3×3 block as nw, n, ne, w, c, e, sw, s, se.
func nine(prefix string, col, row int) []Entry {
	parts := []string{"nw", "n", "ne", "w", "c", "e", "sw", "s", "se"}
	out := make([]Entry, len(parts))
	for i, p := range parts {
		out[i] = Entry{prefix + "-" + p, rpg(col+i%3, row+i/3)}
	}
	return out
}

var manifest = concat(
	[]Entry{
		{"floor", rpg(8, 2)},
		{"wood", rpg(5, 2)},
	},
	nine("carpet-1", 15, 25),
	nine("carpet-2", 9, 25),
	nine("carpet-3", 12, 25),
	[]Entry{
		// Wall tops, named by the sides that join another wall top.
		{"wall-s", rpg(13, 13)},
		{"wall-n", rpg(13, 14)},
		{"wall-ns", rpg(15, 13)},
		{"wall-ew", rpg(14, 12)},
		{"wall-ne", rpg(16, 13)},
		{"wall-nw", rpg(17, 13)},
		// Wall fronts, named by the open ends.
		{"front", rpg(13, 15)},
		{"front-w", rpg(14, 15)},
		{"front-e", rpg(16, 15)},

		{"table-w", indoor(0, 1)},
		{"table", indoor(1, 1)},
		{"table-e", indoor(2, 1)},
		{"desk-w", indoor(4, 4)},
		{"desk", indoor(5, 4)},
		{"desk-e", indoor(6, 4)},
		{"chair-s", indoor(0, 2)},
		{"chair-n", indoor(1, 2)},
		{"chair-e", indoor(2, 2)},
		{"chair-w", indoor(3, 2)},
		{"monitor-front", custom("monitor-front", 0)},
		{"monitor-back", custom("monitor-back", 0)},
		{"tv-w", custom("tv", 0)},
		{"tv-e", custom("tv", 1)},

		{"counter-doors", indoor(0, 12)},
		{"counter-drawer", indoor(1, 12)},
		{"counter-bottles", indoor(5, 12)},
		{"counter-jars", indoor(6, 12)},
		{"sink", indoor(8, 12)},
		{"stove", indoor(14, 14)},
		{"fridge", custom("fridge", 0)},

		{"plant", indoor(16, 0)},
		{"plant-2", indoor(17, 0)},
		{"sofa-w", indoor(14, 7)},
		{"sofa-e", indoor(15, 7)},
		{"armchair", indoor(8, 6)},
		{"shelf-w", rpg(46, 14)},
		{"shelf-1", rpg(47, 14)},
		{"shelf-2", rpg(48, 14)},
		{"shelf-3", rpg(49, 14)},
		{"shelf-e", rpg(50, 14)},

		{"window", rpg(41, 4)},
		{"picture", indoor(19, 12)},
		{"picture-2", indoor(19, 13)},
		{"picture-3", indoor(19, 14)},
		{"panel-w", indoor(20, 12)},
		{"panel-e", indoor(21, 12)},
		{"wall-shelf", indoor(19, 17)},
		{"runner-w", indoor(16, 17)},
		{"runner", indoor(17, 17)},
		{"runner-e", indoor(18, 17)},
	},
)

func concat(parts ...[]Entry) []Entry {
	var out []Entry
	for _, p := range parts {
		out = append(out, p...)
	}
	return out
}
