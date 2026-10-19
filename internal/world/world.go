// Package world is the authoritative, single-threaded game state of a space.
// It has no goroutines or clocks: callers drive it with Step.
package world

import (
	"cmp"
	"errors"
	"slices"
	"time"

	"github.com/victoroliveirabarros/vb-office-32/internal/tilemap"
)

const (
	TickRate         = 20
	TickInterval     = time.Second / TickRate
	StepCooldown     = 150 * time.Millisecond
	MaxPendingInputs = 8

	// maxLast bounds how many departed players keep their last position.
	maxLast = 1000

	// stepSlack absorbs ticker jitter: a step is due this much early, and a
	// step taken up to this much late keeps the cadence of the previous one.
	stepSlack = TickInterval / 2
)

var (
	ErrUnknownPlayer = errors.New("unknown player")
	ErrStaleSeq      = errors.New("stale input sequence")
	ErrQueueFull     = errors.New("input queue full")
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
	ID   string
	Name string
	Pos  tilemap.Point
	Dir  Dir
}

type Input struct {
	Seq uint32
	Dir Dir
}

// Delta is the outcome of a Step. Moved holds players whose position or
// direction changed, sorted by ID; Acks holds the new ack of every player
// that consumed an input; Zones holds the zone ID, "" outside, of every
// player that changed zone; Nearby holds the sorted near set of every player
// whose set changed since the previous Step.
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

		near:        make(map[string]map[string]struct{}),
		nearPending: make(map[string]struct{}),
		nearBefore:  make(map[string][]string),
	}
}

// Join adds a player or, if id is already present, resets its input state
// for a new connection while keeping its position and near set. The new
// connection is expected to read Nearby, so a pending change to that set is
// not reported again by Step. A new player's near set is computed by the
// next Step; its zone is set at once and, like a kept one, never reported in
// Delta.Zones, since the new connection reads it with Zone.
func (s *Space) Join(id, name string) Player {
	if p, ok := s.players[id]; ok {
		p.Name = name
		p.queue = p.queue[:0]
		p.lastSeq = 0
		delete(s.nearBefore, id)
		return p.Player
	}

	p := &player{Player: Player{ID: id, Name: name, Dir: Down}}
	if l, ok := s.last[id]; ok {
		p.Pos, p.Dir = l.pos, l.dir
		delete(s.last, id)
	} else {
		p.Pos = s.m.Spawns[s.nextSpawn%len(s.m.Spawns)]
		s.nextSpawn++
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
	s.last[id] = lastSeen{pos: p.Pos, dir: p.Dir, order: s.lastOrder}
	delete(s.players, id)
	s.dropNear(id)
	if len(s.last) > s.lastCap {
		s.evictOldest()
	}
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
	for _, p := range s.players {
		if now.Before(p.nextStep.Add(-stepSlack)) {
			continue
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
		if to := p.Pos.Add(in.Dir.offset()); !s.m.Blocked(to) {
			p.Pos = to
		}
		if p.Player != before {
			d.Moved = append(d.Moved, p.Player)
		}
		if p.Pos != before.Pos {
			check = append(check, p.ID)
			if z := s.m.ZoneAt(p.Pos); z != p.zone {
				p.zone = z
				if d.Zones == nil {
					d.Zones = make(map[string]string)
				}
				d.Zones[p.ID] = s.zoneID(z)
			}
		}
		if d.Acks == nil {
			d.Acks = make(map[string]uint32)
		}
		d.Acks[p.ID] = in.Seq
	}
	slices.SortFunc(d.Moved, byID)
	d.Nearby = s.stepNear(check, d.Zones)
	return d
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
