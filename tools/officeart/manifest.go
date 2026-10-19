package main

// Entry names a tile of the atlas. Its index in manifest is its place in the
// atlas, so its gid in the map is that index + 1.
type Entry struct {
	Name string
	Source
}

func rpg(col, row int) Source                 { return Source{"rpg", col, row} }
func indoor(col, row int) Source              { return Source{"indoor", col, row} }
func custom(name string, col, row int) Source { return Source{"custom:" + name, col, row} }

// nine lists a 3×3 block as nw, n, ne, w, c, e, sw, s, se.
func nine(prefix string, src func(col, row int) Source, col, row int) []Entry {
	parts := []string{"nw", "n", "ne", "w", "c", "e", "sw", "s", "se"}
	out := make([]Entry, len(parts))
	for i, p := range parts {
		out[i] = Entry{prefix + "-" + p, src(col+i%3, row+i/3)}
	}
	return out
}

func ring(col, row int) Source { return custom("ring", col, row) }

var manifest = concat(
	[]Entry{
		{"outside", custom("outside", 0, 0)},
		{"floor", rpg(8, 2)},
		{"wood", rpg(5, 2)},
	},
	nine("carpet-teal", rpg, 15, 25),
	nine("carpet-orange", rpg, 12, 25),
	nine("carpet-beige", rpg, 6, 25),
	nine("carpet-grey", rpg, 3, 25),
	nine("ring", ring, 0, 0),
	[]Entry{
		// Wall tops, named by the sides that join another wall top.
		{"wall-s", rpg(13, 13)},
		{"wall-n", rpg(13, 14)},
		{"wall-ns", rpg(15, 13)},
		{"wall-ew", rpg(14, 12)},
		{"wall-ne", rpg(16, 13)},
		{"wall-nw", rpg(17, 13)},
		{"wall-nse", rpg(18, 12)},
		{"wall-nsw", rpg(18, 13)},
		// Wall fronts, named by the open ends.
		{"front", rpg(13, 15)},
		{"front-w", rpg(14, 15)},
		{"front-e", rpg(16, 15)},
		{"front-w-e", rpg(15, 15)},

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
		{"monitor-front", custom("monitor-front", 0, 0)},
		{"monitor-back", custom("monitor-back", 0, 0)},
		{"tv-w", custom("tv", 0, 0)},
		{"tv-e", custom("tv", 1, 0)},

		{"counter-doors", indoor(0, 12)},
		{"counter-drawer", indoor(1, 12)},
		{"counter-bottles", indoor(5, 12)},
		{"counter-jars", indoor(6, 12)},
		{"sink", indoor(8, 12)},
		{"stove", indoor(14, 14)},
		{"fridge", custom("fridge", 0, 0)},

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

		{"ring-post-nw", custom("ring-ropes", 0, 0)},
		{"ring-post-ne", custom("ring-ropes", 2, 0)},
		{"ring-post-sw", custom("ring-ropes", 0, 2)},
		{"ring-post-se", custom("ring-ropes", 2, 2)},
		{"ring-rope-h", custom("ring-ropes", 1, 0)},
		{"ring-rope-v", custom("ring-ropes", 0, 1)},
		{"punching-bag", custom("punching-bag", 0, 0)},
		{"bench-w", indoor(10, 4)},
		{"bench-e", indoor(11, 4)},
	},
)

func concat(parts ...[]Entry) []Entry {
	var out []Entry
	for _, p := range parts {
		out = append(out, p...)
	}
	return out
}
