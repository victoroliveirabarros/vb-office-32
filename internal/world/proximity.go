package world

import (
	"slices"

	"github.com/victoroliveirabarros/vb-office-32/internal/tilemap"
)

// Squared distances in tiles: a pair becomes near at 4 tiles and stops being
// near beyond 5, so a player on the edge does not flap.
const (
	nearEnter = 4 * 4
	nearLeave = 5 * 5
)

func near(d2 int, was bool) bool {
	switch {
	case d2 <= nearEnter:
		return true
	case d2 > nearLeave:
		return false
	}
	return was
}

func dist2(a, b tilemap.Point) int {
	dx, dy := a.X-b.X, a.Y-b.Y
	return dx*dx + dy*dy
}

// Nearby returns the sorted IDs near id, never nil.
func (s *Space) Nearby(id string) []string {
	ids := make([]string, 0, len(s.near[id]))
	for n := range s.near[id] {
		ids = append(ids, n)
	}
	slices.Sort(ids)
	return ids
}

// link and unlink keep the relation symmetric and remember, for each side,
// the set last reported before this change.
func (s *Space) link(a, b string) {
	s.touch(a)
	s.touch(b)
	s.addNear(a, b)
	s.addNear(b, a)
}

func (s *Space) unlink(a, b string) {
	s.touch(a)
	s.touch(b)
	delete(s.near[a], b)
	delete(s.near[b], a)
}

func (s *Space) addNear(a, b string) {
	set, ok := s.near[a]
	if !ok {
		set = make(map[string]struct{})
		s.near[a] = set
	}
	set[b] = struct{}{}
}

func (s *Space) touch(id string) {
	if _, ok := s.nearBefore[id]; !ok {
		s.nearBefore[id] = s.Nearby(id)
	}
}

func (s *Space) dropNear(id string) {
	for n := range s.near[id] {
		s.unlink(id, n)
	}
	delete(s.near, id)
	delete(s.nearPending, id)
	delete(s.nearBefore, id)
}

// stepNear re-evaluates the players in check: neighbors beyond nearLeave are
// dropped and players within nearEnter added. It returns the set of each
// player whose set differs from the one last returned.
func (s *Space) stepNear(check []string) map[string][]string {
	if len(check) > 0 {
		all := make([]*player, 0, len(s.players))
		for _, p := range s.players {
			all = append(all, p)
		}
		for _, id := range check {
			p := s.players[id]
			for oid := range s.near[id] {
				if !near(dist2(p.Pos, s.players[oid].Pos), true) {
					s.unlink(id, oid)
				}
			}
			for _, o := range all {
				if o == p || !near(dist2(p.Pos, o.Pos), false) {
					continue
				}
				if _, ok := s.near[id][o.ID]; !ok {
					s.link(id, o.ID)
				}
			}
		}
	}
	var out map[string][]string
	for id, before := range s.nearBefore {
		if now := s.Nearby(id); !slices.Equal(now, before) {
			if out == nil {
				out = make(map[string][]string)
			}
			out[id] = now
		}
	}
	clear(s.nearBefore)
	return out
}
