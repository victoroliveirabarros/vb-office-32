package main

// Entry names a tile of the atlas. Its index in manifest is its place in the
// atlas, so its gid in the map is that index + 1. Paint, if set, recolors it.
type Entry struct {
	Name string
	Source
	Paint *Paint
}

// paint sets p on entries.
func paint(p *Paint, entries ...Entry) []Entry {
	out := make([]Entry, len(entries))
	for i, e := range entries {
		e.Paint = p
		out[i] = e
	}
	return out
}

func rpg(col, row int) Source                 { return Source{"rpg", col, row} }
func indoor(col, row int) Source              { return Source{"indoor", col, row} }
func custom(name string, col, row int) Source { return Source{"custom:" + name, col, row} }

// nine lists a 3×3 block as nw, n, ne, w, c, e, sw, s, se.
func nine(prefix string, src func(col, row int) Source, col, row int) []Entry {
	parts := []string{"nw", "n", "ne", "w", "c", "e", "sw", "s", "se"}
	out := make([]Entry, len(parts))
	for i, p := range parts {
		out[i] = Entry{Name: prefix + "-" + p, Source: src(col+i%3, row+i/3)}
	}
	return out
}

func ring(col, row int) Source { return custom("ring", col, row) }

func cubicle(col, row int) Source { return custom("cubicle-floor", col, row) }

func desk(col, row int) Source { return custom("office-desk", col, row) }

func glass(col, row int) Source { return custom("glass", col, row) }

// The Kenney art keeps its drawing and takes the corporate palette: cool
// white walls with a graphite skirting and grey tops, neutral rugs, white
// tables, navy sofas, yellow armchairs and seats, grey shelves.
var (
	wallTop = &Paint{"wall-top", map[string]string{
		"908570": "5b6170", "d9caa9": "e4e7ec", "b4a78c": "a9afbb", "e6dabf": "f3f4f7",
	}}
	wallFront = &Paint{"wall-front", map[string]string{
		"908570": "3a3f4b", "d9caa9": "eef0f3", "e6dabf": "d3d7de", "b4a78c": "5c6372", "c4b79b": "d9dce2",
	}}
	carpetBlue = &Paint{"carpet-blue", map[string]string{
		"37aaa5": "3a6c9f", "287d79": "0e3a58", "44bbb6": "5583b5",
	}}
	carpetSlate = &Paint{"carpet-slate", map[string]string{
		"b65e26": "7d8ba1", "914a1e": "4f5c72", "d27134": "93a1b5",
	}}
	rugLight = &Paint{"rug-light", map[string]string{
		"d9caa9": "dedad1", "908570": "8e8a81", "ece2cd": "ebe8e1",
	}}
	rugGrey = &Paint{"rug-grey", map[string]string{
		"cccccc": "c5c9d1", "868686": "7a8191", "e3e3e3": "d8dbe1",
	}}
	runner = &Paint{"runner", map[string]string{
		"ece2cd": "7f8696", "d9caa9": "727989", "8f673f": "474d5b", "c8a480": "989fae", "b98b5e": "5d6474",
	}}
	whiteboard = &Paint{"whiteboard", map[string]string{
		"d9caa9": "f7f8fa", "ece2cd": "c3d3e6", "a69c70": "8f97a5", "fff4c9": "ffffff", "ffe6af": "dde1e8",
	}}
	whiteTable = &Paint{"white-table", map[string]string{
		"c8a480": "eef0f3", "b98b5e": "c5cbd5", "8f673f": "6f7787",
	}}
	navySofa = &Paint{"navy-sofa", map[string]string{
		"c66527": "2f4f72", "a35422": "213a57", "b98b5e": "3d4757", "8f673f": "262c37",
		"e6dabf": "cdd3dc", "c8a480": "55607a", "b4a78c": "8c95a6",
	}}
	yellowArmchair = &Paint{"yellow-armchair", map[string]string{
		"c66527": "f2b632", "a35422": "cc9418", "b98b5e": "3d4757", "8f673f": "262c37",
		"e6dabf": "cdd3dc", "c8a480": "55607a", "b4a78c": "8c95a6",
	}}
	yellowSeat = &Paint{"yellow-seat", map[string]string{"c66527": "f2b632"}}
	greyShelf  = &Paint{"grey-shelf", map[string]string{
		"c8a480": "dfe2e7", "b98b5e": "b5bbc6", "8f673f": "636a7a", "cdc0a4": "f2f3f5", "c66527": "2f5d8a",
	}}
	lightChair = &Paint{"light-chair", map[string]string{
		"26292e": "5b6170", "646b75": "e2e5ea", "4a5059": "bfc4cd", "383d44": "9ba1ad", "4f7479": "8fa0b4",
	}}
	navyChair = &Paint{"navy-chair", map[string]string{
		"646b75": "3f6286", "4a5059": "1f3c5a", "383d44": "152b42",
	}}
)

var manifest = concat(
	[]Entry{
		{Name: "outside", Source: custom("outside", 0, 0)},
		{Name: "floor", Source: custom("floors", 0, 0)},
		{Name: "porcelain", Source: custom("floors", 1, 0)},
		{Name: "rubber", Source: custom("floors", 2, 0)},
	},
	paint(carpetBlue, nine("carpet-blue", rpg, 15, 25)...),
	paint(carpetSlate, nine("carpet-slate", rpg, 12, 25)...),
	paint(rugLight, nine("rug-light", rpg, 6, 25)...),
	paint(rugGrey, nine("rug-grey", rpg, 3, 25)...),
	nine("cubicle", cubicle, 0, 0),
	nine("ring", ring, 0, 0),
	paint(wallTop,
		// Wall tops, named by the sides that join another wall top.
		Entry{Name: "wall-s", Source: rpg(13, 13)},
		Entry{Name: "wall-n", Source: rpg(13, 14)},
		Entry{Name: "wall-ns", Source: rpg(15, 13)},
		Entry{Name: "wall-ew", Source: rpg(14, 12)},
		Entry{Name: "wall-ne", Source: rpg(16, 13)},
		Entry{Name: "wall-nw", Source: rpg(17, 13)},
		Entry{Name: "wall-nse", Source: rpg(18, 12)},
		Entry{Name: "wall-nsw", Source: rpg(18, 13)},
	),
	paint(wallFront,
		// Wall fronts, named by the open ends.
		Entry{Name: "front", Source: rpg(13, 15)},
		Entry{Name: "front-w", Source: rpg(14, 15)},
		Entry{Name: "front-e", Source: rpg(16, 15)},
	),
	[]Entry{
		{Name: "glass-front", Source: glass(0, 0)},
		{Name: "glass-front-w", Source: glass(1, 0)},
		{Name: "glass-front-e", Source: glass(2, 0)},
		{Name: "glass-front-w-e", Source: glass(3, 0)},
		{Name: "glass-wall-ns", Source: glass(0, 1)},
		{Name: "glass-wall-n", Source: glass(1, 1)},
		{Name: "glass-wall-s", Source: glass(2, 1)},
	},
	paint(whiteTable,
		Entry{Name: "table-w", Source: indoor(0, 1)},
		Entry{Name: "table", Source: indoor(1, 1)},
		Entry{Name: "table-e", Source: indoor(2, 1)},
	),
	paint(yellowSeat,
		Entry{Name: "wood-chair-s", Source: indoor(0, 2)},
		Entry{Name: "wood-chair-n", Source: indoor(1, 2)},
	),
	[]Entry{
		{Name: "chair-s", Source: custom("office-chair", 0, 0)},
		{Name: "chair-n", Source: custom("office-chair", 1, 0)},
		{Name: "chair-e", Source: custom("office-chair", 2, 0)},
		{Name: "chair-w", Source: custom("office-chair", 3, 0)},
		{Name: "chair-s-light", Source: custom("office-chair", 0, 0), Paint: lightChair},
		{Name: "chair-n-navy", Source: custom("office-chair", 1, 0), Paint: navyChair},
		{Name: "desk-nw", Source: desk(0, 0)},
		{Name: "desk-n", Source: desk(1, 0)},
		{Name: "desk-ne", Source: desk(2, 0)},
		{Name: "desk-sw", Source: desk(0, 1)},
		{Name: "desk-s", Source: desk(1, 1)},
		{Name: "desk-se", Source: desk(2, 1)},
		{Name: "monitor-front", Source: custom("monitor-front", 0, 0)},
		{Name: "monitor-back", Source: custom("monitor-back", 0, 0)},
		{Name: "dual-front-w", Source: custom("dual-monitor", 0, 0)},
		{Name: "dual-front-e", Source: custom("dual-monitor", 1, 0)},
		{Name: "dual-back-w", Source: custom("dual-monitor", 2, 0)},
		{Name: "dual-back-e", Source: custom("dual-monitor", 3, 0)},
		{Name: "laptop-front", Source: custom("laptop", 0, 0)},
		{Name: "laptop-back", Source: custom("laptop", 1, 0)},
		{Name: "aquarium-w", Source: custom("aquarium", 0, 0)},
		{Name: "aquarium-e", Source: custom("aquarium", 1, 0)},
		{Name: "desk-papers", Source: custom("desk-items", 0, 0)},
		{Name: "desk-books", Source: custom("desk-items", 1, 0)},
		{Name: "desk-lamp", Source: custom("desk-items", 2, 0)},
		{Name: "desk-plant", Source: custom("desk-items", 3, 0)},
		{Name: "desk-computer", Source: custom("desk-items", 4, 0)},
		{Name: "desk-pot", Source: custom("desk-items", 5, 0)},
		{Name: "desk-photo", Source: custom("desk-items", 6, 0)},
		{Name: "tv-w", Source: custom("tv", 0, 0)},
		{Name: "tv-e", Source: custom("tv", 1, 0)},

		{Name: "counter-doors", Source: indoor(0, 12)},
		{Name: "counter-drawer", Source: indoor(1, 12)},
		{Name: "counter-bottles", Source: indoor(5, 12)},
		{Name: "counter-jars", Source: indoor(6, 12)},
		{Name: "sink", Source: indoor(8, 12)},
		{Name: "stove", Source: indoor(14, 14)},
		{Name: "fridge", Source: custom("fridge", 0, 0)},

		{Name: "plant", Source: indoor(16, 0)},
		{Name: "plant-2", Source: indoor(17, 0)},
		{Name: "sofa-w", Source: indoor(14, 7), Paint: navySofa},
		{Name: "sofa-e", Source: indoor(15, 7), Paint: navySofa},
		{Name: "armchair", Source: indoor(8, 6), Paint: yellowArmchair},
	},
	paint(greyShelf,
		Entry{Name: "shelf-w", Source: rpg(46, 14)},
		Entry{Name: "shelf-1", Source: rpg(47, 14)},
		Entry{Name: "shelf-2", Source: rpg(48, 14)},
		Entry{Name: "shelf-3", Source: rpg(49, 14)},
		Entry{Name: "shelf-e", Source: rpg(50, 14)},
	),
	[]Entry{
		{Name: "window", Source: rpg(41, 4)},
		{Name: "picture", Source: indoor(19, 12)},
		{Name: "picture-2", Source: indoor(19, 13)},
		{Name: "picture-3", Source: indoor(19, 14)},
		{Name: "whiteboard-w", Source: indoor(20, 12), Paint: whiteboard},
		{Name: "whiteboard-e", Source: indoor(21, 12), Paint: whiteboard},
		{Name: "wall-shelf", Source: indoor(19, 17)},
		{Name: "runner-w", Source: indoor(16, 17), Paint: runner},
		{Name: "runner", Source: indoor(17, 17), Paint: runner},
		{Name: "runner-e", Source: indoor(18, 17), Paint: runner},

		{Name: "ring-post-nw", Source: custom("ring-ropes", 0, 0)},
		{Name: "ring-post-ne", Source: custom("ring-ropes", 2, 0)},
		{Name: "ring-post-sw", Source: custom("ring-ropes", 0, 2)},
		{Name: "ring-post-se", Source: custom("ring-ropes", 2, 2)},
		{Name: "ring-rope-h", Source: custom("ring-ropes", 1, 0)},
		{Name: "ring-rope-v", Source: custom("ring-ropes", 0, 1)},
		{Name: "punching-bag", Source: custom("punching-bag", 0, 0)},
		{Name: "bench-w", Source: indoor(10, 4)},
		{Name: "bench-e", Source: indoor(11, 4)},
	},
)

func concat(parts ...[]Entry) []Entry {
	var out []Entry
	for _, p := range parts {
		out = append(out, p...)
	}
	return out
}
