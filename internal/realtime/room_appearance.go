package realtime

import (
	"context"

	"github.com/victoroliveirabarros/vb-office-32/internal/avatar"
)

// sessionAppearance is a look the session checked: apply is set only for a
// look in the catalog within the identity's limit.
type sessionAppearance struct {
	sess  *Session
	look  avatar.Appearance
	apply bool
}

func (r *Room) appearance(ctx context.Context, a sessionAppearance) error {
	return submit(ctx, r, r.looks, a)
}

// handleAppearance tells everyone about a new look; a look that changed
// nothing or was not applied goes back only to the sender, with the current
// one.
func (r *Room) handleAppearance(a sessionAppearance) {
	id := a.sess.id
	if m, ok := r.members[id]; !ok || m.sess != a.sess {
		return
	}
	var changed bool
	p, _ := r.space.Player(id)
	if a.apply {
		p, changed = r.space.SetAppearance(id, a.look)
	}
	msg := appearanceMsg{ID: id, Appearance: p.Appearance}
	if changed {
		r.broadcast(typeAppearance, msg, "")
		return
	}
	b, err := encode(typeAppearance, msg)
	if err != nil {
		r.log.Error("encode appearance", "err", err)
		return
	}
	a.sess.send(b)
}
