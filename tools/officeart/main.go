// Command officeart builds the office map and its tile atlas from the Kenney
// sheets in art/kenney, the sprites in art/custom and the plan in office.txt,
// and the avatar parts from art/custom/avatar and internal/avatar:
//
//	go run ./tools/officeart          # writes maps/office.tmj, web/public/game/office-tiles.png, web/public/game/avatar-parts.png and web/src/avatar/*.gen.*
//	go run ./tools/officeart -sheet /tmp/officeart   # also writes review sheets there
//
// It refuses to change which tiles block movement unless told to.
package main

import (
	"bytes"
	_ "embed"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"image"
	"image/png"
	"io/fs"
	"log"
	"os"
	"path/filepath"

	"github.com/victoroliveirabarros/vb-office-32/internal/tilemap"
)

//go:embed office.txt
var officePlan []byte

const (
	mapFile   = "maps/office.tmj"
	atlasFile = "web/public/game/office-tiles.png"
)

type output struct {
	art    *art
	Layers *Layers
	IDs    map[string]int
	Atlas  *image.NRGBA
	PNG    []byte
	TMJ    []byte
}

func generate(root string) (*output, error) {
	plan, err := parsePlan(officePlan)
	if err != nil {
		return nil, fmt.Errorf("office.txt: %w", err)
	}
	layers, err := plan.layers()
	if err != nil {
		return nil, fmt.Errorf("office.txt: %w", err)
	}
	ids, err := gids(layers)
	if err != nil {
		return nil, err
	}
	a, err := loadArt(root)
	if err != nil {
		return nil, err
	}
	atlas, err := a.buildAtlas(manifest)
	if err != nil {
		return nil, err
	}
	if err := a.unusedPaint(); err != nil {
		return nil, err
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, atlas); err != nil {
		return nil, err
	}
	tmj, err := encodeTMJ(layers, ids, atlas.Bounds().Dx(), atlas.Bounds().Dy())
	if err != nil {
		return nil, err
	}
	if _, err := tilemap.Load(bytes.NewReader(tmj)); err != nil {
		return nil, fmt.Errorf("generated map: %w", err)
	}
	return &output{art: a, Layers: layers, IDs: ids, Atlas: atlas, PNG: buf.Bytes(), TMJ: tmj}, nil
}

// blockMask returns, per tile, whether the walls layer of a Tiled map
// blocks it.
func blockMask(tmj []byte) ([]bool, error) {
	var m struct {
		Layers []struct {
			Name string `json:"name"`
			Data []int  `json:"data"`
		} `json:"layers"`
	}
	if err := json.Unmarshal(tmj, &m); err != nil {
		return nil, err
	}
	for _, l := range m.Layers {
		if l.Name != "walls" {
			continue
		}
		mask := make([]bool, len(l.Data))
		for i, gid := range l.Data {
			mask[i] = gid != 0
		}
		return mask, nil
	}
	return nil, errors.New("no walls layer")
}

// sameMask fails when the two maps block different tiles.
func sameMask(old, new []byte) error {
	a, err := blockMask(old)
	if err != nil {
		return fmt.Errorf("current map: %w", err)
	}
	b, err := blockMask(new)
	if err != nil {
		return err
	}
	if len(a) != len(b) {
		return fmt.Errorf("walls layer has %d tiles, the current map %d", len(b), len(a))
	}
	var diff []error
	for i := range a {
		if a[i] != b[i] {
			diff = append(diff, fmt.Errorf("tile %d,%d: blocked %v, was %v", i%mapW, i/mapW, b[i], a[i]))
		}
	}
	return errors.Join(diff...)
}

func main() {
	root := flag.String("root", ".", "repository root")
	sheet := flag.String("sheet", "", "directory for the review sheets (atlas with indices and map preview)")
	allowMask := flag.Bool("allow-mask-change", false, "write the map even if it blocks other tiles than "+mapFile)
	flag.Parse()
	log.SetFlags(0)

	out, err := generate(*root)
	if err != nil {
		log.Fatal(err)
	}
	av, err := generateAvatars(*root)
	if err != nil {
		log.Fatal(err)
	}
	mapPath := filepath.Join(*root, mapFile)
	old, err := os.ReadFile(mapPath)
	switch {
	case errors.Is(err, fs.ErrNotExist):
	case err != nil:
		log.Fatal(err)
	case !*allowMask:
		if err := sameMask(old, out.TMJ); err != nil {
			log.Fatalf("collision would change (use -allow-mask-change if intended):\n%v", err)
		}
	}
	if *sheet != "" {
		if err := writeSheets(*sheet, out); err != nil {
			log.Fatal(err)
		}
		if err := writeAvatarSheets(*sheet, av); err != nil {
			log.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(*root, atlasFile), out.PNG, 0o644); err != nil {
		log.Fatal(err)
	}
	if err := os.WriteFile(mapPath, out.TMJ, 0o644); err != nil {
		log.Fatal(err)
	}
	if err := av.write(*root); err != nil {
		log.Fatal(err)
	}
	b := out.Atlas.Bounds()
	fmt.Printf("%s: %d tiles, %dx%d px, %d bytes\n%s: %d bytes\n", atlasFile, len(manifest), b.Dx(), b.Dy(), len(out.PNG), mapFile, len(out.TMJ))
	b = av.Parts.Bounds()
	fmt.Printf("%s: %dx%d px, %d bytes\n%s, %s\n", partsFile, b.Dx(), b.Dy(), len(av.PNG), catalogFile, swatchFile)
}
