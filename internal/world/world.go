// Package world is the authoritative, single-threaded game state of a space.
// It has no goroutines or clocks: callers drive it with Step.
package world

import (
	"cmp"
	"errors"
	"fmt"
	"slices"
	"time"

	"github.com/victoroliveirabarros/vb-office-32/internal/avatar"
	"github.com/victoroliveirabarros/vb-office-32/internal/tilemap"
)

const (
	TickRate         = 20
	TickInterval     = time.Second / TickRate
	StepCooldown     = 150 * time.Millisecond
	MaxPendingInputs = 8

	// maxLast bounds how many departed players keep their last position and
	// look.
	maxLast = 1000

	// stepSlack absorbs ticker jitter: a step is due this much early, and a
	// step taken up to this much late keeps the cadence of the previous one.
	stepSlack = TickInterval / 2
)

var (
	ErrUnknownPlayer = errors.New("unknown player")
	ErrStaleSeq      = errors.New("stale input sequence")
	ErrQueueFull     = errors.New("input queue full")
	ErrUnknownZone   = errors.New("unknown zone")
)

type Dir string

const (
	Up    Dir = "up"
	Down  Dir = "down"
	Left  Dir = "left"
	Right Dir = "right"
)

func (d Dir) Valid() bool {
	switch d {
	case Up, Down, Left, Right:
		return true
	}
	return false
}

func (d Dir) offset() tilemap.Point {
	switch d {
	case Up:
		return tilemap.Point{Y: -1}
	case Down:
		return tilemap.Point{Y: 1}
	case Left:
		return tilemap.Point{X: -1}
	case Right:
		return tilemap.Point{X: 1}
	}
	return tilemap.Point{}
}

type Player struct {
	ID         string
	Name       string
	Pos        tilemap.Point
	Dir        Dir
	Appearance avatar.Appearance
}

type Input struct {
	Seq uint32
	Dir Dir
}

// Delta is the outcome of a Step. Moved holds players whose position or
// direction changed, sorted by ID; Acks holds the new ack of every player
// that consumed an input; Zones holds the zone ID, "" outside, of every
// player that changed zone; Nearby holds the sorted near set of every player
// whose set changed since the previous Step. A player moved out of a zone by
// Lock is in Moved and Zones, with the inputs it lost acked.
type Delta struct {
	Tick   uint64
	Moved  []Player
	Acks   map[string]uint32
	Zones  map[string]string
	Nearby map[string][]string
}

type player struct {
	Player
	// zone is the index in the map's zones, -1 outside.
	zone    int
	queue   []Input
	lastSeq uint32
	// nextStep is zero while the player is idle, so the next step starts a
	// new cadence instead of continuing the old one.
	nextStep time.Time
}

type lastSeen struct {
	pos   tilemap.Point
	dir   Dir
	look  avatar.Appearance
	order uint64
}

type Space struct {
	m         *tilemap.Map
	players   map[string]*player
	last      map[string]lastSeen
	lastCap   int
	lastOrder uint64
	nextSpawn int
	tick      uint64

	// access holds, per zone, who may enter it; nil is open to everyone.
	access []map[string]struct{}
	// forced holds the players Lock moved out since the last Step, with the
	// ack of the inputs they lost, 0 for none.
	forced map[string]uint32

	near        map[string]map[string]struct{}
	nearPending map[string]struct{}
	nearBefore  map[string][]string
}

func NewSpace(m *tilemap.Map) *Space {
	return &Space{
		m:       m,
		players: make(map[string]*player),
		last:    make(map[string]lastSeen),
		lastCap: maxLast,
		access:  make([]map[string]struct{}, len(m.Zones)),
		forced:  make(map[string]uint32),

		near:        make(map[string]map[string]struct{}),
		nearPending: make(map[string]struct{}),
		nearBefore:  make(map[string][]string),
	}
}

// Join adds a player or, if id is already present, resets its input state
// for a new connection while keeping its position, look and near set. A new
// player takes its last position and look or, unknown, a spawn point and
// avatar.Default(id). The new
// connection is expected to read Nearby, so a pending change to that set is
// not reported again by Step. A new player's near set is computed by the
// next Step; its zone is set at once and, like a kept one, never reported in
// Delta.Zones, since the new connection reads it with Zone. A player Lock
// moved out is still reported by the next Step, so the others see it leave,
// but without an ack. A last position in a zone id may not enter is traded
// for the nearest tile outside.
func (s *Space) Join(id, name string) Player {
	return s.join(id, name, nil)
}

// JoinAt is Join with a new or returning player starting at at; a present
// one keeps its position.
func (s *Space) JoinAt(id, name string, at tilemap.Point) Player {
	return s.join(id, name, &at)
}

func (s *Space) join(id, name string, at *tilemap.Point) Player {
	if p, ok := s.players[id]; ok {
		p.Name = name
		p.queue = p.queue[:0]
		p.lastSeq = 0
		delete(s.nearBefore, id)
		if _, ok := s.forced[id]; ok {
			s.forced[id] = 0
		}
		return p.Player
	}

	p := &player{Player: Player{ID: id, Name: name, Dir: Down}}
	if l, ok := s.last[id]; ok {
		p.Pos, p.Dir, p.Appearance = l.pos, l.dir, l.look
		delete(s.last, id)
	} else {
		p.Pos = s.m.Spawns[s.nextSpawn%len(s.m.Spawns)]
		p.Appearance = avatar.Default(id)
		if at == nil {
			s.nextSpawn++
		}
	}
	if at != nil {
		p.Pos = *at
	}
	if z := s.m.ZoneAt(p.Pos); z >= 0 && !s.allowed(z, id) {
		p.Pos = s.m.Outside(p.Pos)
	}
	p.zone = s.m.ZoneAt(p.Pos)
	s.players[id] = p
	s.nearPending[id] = struct{}{}
	return p.Player
}

func (s *Space) Leave(id string) {
	p, ok := s.players[id]
	if !ok {
		return
	}
	s.lastOrder++
	s.last[id] = lastSeen{pos: p.Pos, dir: p.Dir, look: p.Appearance, order: s.lastOrder}
	delete(s.players, id)
	delete(s.forced, id)
	s.dropNear(id)
	if len(s.last) > s.lastCap {
		s.evictOldest()
	}
}

// Player returns the player id; false when id is not in the space.
func (s *Space) Player(id string) (Player, bool) {
	p, ok := s.players[id]
	if !ok {
		return Player{}, false
	}
	return p.Player, true
}

// SetAppearance changes the look of id and reports whether it changed. An
// unknown id or a look outside the catalog changes nothing.
func (s *Space) SetAppearance(id string, a avatar.Appearance) (Player, bool) {
	p, ok := s.players[id]
	if !ok {
		return Player{}, false
	}
	if !a.Valid() || p.Appearance == a {
		return p.Player, false
	}
	p.Appearance = a
	return p.Player, true
}

func (s *Space) evictOldest() {
	var oldest string
	var order uint64
	for id, l := range s.last {
		if oldest == "" || l.order < order {
			oldest, order = id, l.order
		}
	}
	delete(s.last, oldest)
}

func (s *Space) Enqueue(id string, in Input) error {
	p, ok := s.players[id]
	if !ok {
		return ErrUnknownPlayer
	}
	if in.Seq <= p.lastSeq {
		return ErrStaleSeq
	}
	if len(p.queue) >= MaxPendingInputs {
		return ErrQueueFull
	}
	p.lastSeq = in.Seq
	p.queue = append(p.queue, in)
	return nil
}

func (s *Space) Step(now time.Time) Delta {
	s.tick++
	d := Delta{Tick: s.tick}
	check := make([]string, 0, len(s.nearPending))
	for id := range s.nearPending {
		check = append(check, id)
	}
	clear(s.nearPending)
	for id, ack := range s.forced {
		p := s.players[id]
		d.Moved = append(d.Moved, p.Player)
		if d.Zones == nil {
			d.Zones = make(map[string]string)
		}
		d.Zones[id] = s.zoneID(p.zone)
		if ack > 0 {
			if d.Acks == nil {
				d.Acks = make(map[string]uint32)
			}
			d.Acks[id] = ack
		}
		check = append(check, id)
	}
	for _, p := range s.players {
		if now.Before(p.nextStep.Add(-stepSlack)) {
			continue
		}
		if len(s.forced) > 0 {
			if _, ok := s.forced[p.ID]; ok {
				continue
			}
		}
		if len(p.queue) == 0 {
			p.nextStep = time.Time{}
			continue
		}
		in := p.queue[0]
		p.queue = slices.Delete(p.queue, 0, 1)
		p.nextStep = p.stepBase(now).Add(StepCooldown)

		before := p.Player
		p.Dir = in.Dir
		// A zone id may not enter is as solid as a wall.
		if to := p.Pos.Add(in.Dir.offset()); !s.m.Blocked(to) {
			if z := s.m.ZoneAt(to); z == p.zone || s.allowed(z, p.ID) {
				p.Pos = to
				check = append(check, p.ID)
				if z != p.zone {
					p.zone = z
					if d.Zones == nil {
						d.Zones = make(map[string]string)
					}
					d.Zones[p.ID] = s.zoneID(z)
				}
			}
		}
		if p.Player != before {
			d.Moved = append(d.Moved, p.Player)
		}
		if d.Acks == nil {
			d.Acks = make(map[string]uint32)
		}
		d.Acks[p.ID] = in.Seq
	}
	clear(s.forced)
	slices.SortFunc(d.Moved, byID)
	d.Nearby = s.stepNear(check, d.Zones)
	return d
}

// Lock lets only ids into zone, nobody when ids is empty. Players inside
// who may not stay are moved at once to the nearest tile outside, with their
// pending inputs dropped, and lose at once the neighbors they no longer hear;
// the next Step reports them and links their new neighbors.
func (s *Space) Lock(zone string, ids ...string) error {
	z := s.m.ZoneIndex(zone)
	if z < 0 {
		return fmt.Errorf("%w %q", ErrUnknownZone, zone)
	}
	set := make(map[string]struct{}, len(ids))
	for _, id := range ids {
		set[id] = struct{}{}
	}
	s.access[z] = set
	var out []string
	for id, p := range s.players {
		if p.zone != z || s.allowed(z, id) {
			continue
		}
		p.Pos = s.m.Outside(p.Pos)
		p.zone = s.m.ZoneAt(p.Pos)
		p.queue = p.queue[:0]
		p.nextStep = time.Time{}
		s.forced[id] = p.lastSeq
		out = append(out, id)
	}
	// Only once everyone is out, and without hysteresis, as Step does for a
	// zone change.
	for _, id := range out {
		p := s.players[id]
		for oid := range s.near[id] {
			if !audible(p, s.players[oid], false) {
				s.unlink(id, oid)
			}
		}
	}
	return nil
}

// allowed reports whether id may enter zone z, -1 being outside every zone.
func (s *Space) allowed(z int, id string) bool {
	if z < 0 || s.access[z] == nil {
		return true
	}
	_, ok := s.access[z][id]
	return ok
}

// Seat returns the tile of zone where its owner sits; false when there is
// no such zone.
func (s *Space) Seat(zone string) (tilemap.Point, bool) {
	z := s.m.ZoneIndex(zone)
	if z < 0 {
		return tilemap.Point{}, false
	}
	return s.m.Seat(z), true
}

func (s *Space) Zones() []tilemap.Zone {
	return slices.Clone(s.m.Zones)
}

// stepBase anchors the cadence on when the step was due rather than on now, so
// a late tick does not delay every following step.
func (p *player) stepBase(now time.Time) time.Time {
	if p.nextStep.IsZero() {
		return now
	}
	if earliest := now.Add(-stepSlack); p.nextStep.Before(earliest) {
		return earliest
	}
	return p.nextStep
}

// Zone returns the zone id is in; false outside every zone or when id is
// not in the space.
func (s *Space) Zone(id string) (tilemap.Zone, bool) {
	p, ok := s.players[id]
	if !ok || p.zone < 0 {
		return tilemap.Zone{}, false
	}
	return s.m.Zones[p.zone], true
}

func (s *Space) zoneID(z int) string {
	if z < 0 {
		return ""
	}
	return s.m.Zones[z].ID
}

func (s *Space) Players() []Player {
	ps := make([]Player, 0, len(s.players))
	for _, p := range s.players {
		ps = append(ps, p.Player)
	}
	slices.SortFunc(ps, byID)
	return ps
}

func byID(a, b Player) int { return cmp.Compare(a.ID, b.ID) }
