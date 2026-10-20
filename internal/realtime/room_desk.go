package realtime

import (
	"cmp"
	"context"
	"slices"
	"time"
)

// maxGuests bounds the guests of a desk.
const maxGuests = 20

// deskState is a desk zone. A locked desk has an owner configured and lets
// in only the owner and the guests; ownerID is set once the owner connects
// to this process.
type deskState struct {
	id, zone string
	// name is the owner's configured name, lastName the name of the owner's
	// latest session.
	name     string
	locked   bool
	ownerID  string
	lastName string
	online   bool
	// guests maps the invited identities to their names.
	guests map[string]string
	// seq tells a stale grace timer from the current one.
	seq   uint64
	timer *time.Timer
}

type sessionDesk struct {
	sess   *Session
	target string
	invite bool
}

type deskExpiry struct {
	id  string
	seq uint64
}

// ownerName is the session's name while the owner is online; offline, the
// configured name, the last session's or the zone's.
func (d *deskState) ownerName() string {
	if d.online {
		return d.lastName
	}
	return cmp.Or(d.name, d.lastName, d.zone)
}

func (d *deskState) stopGrace() {
	if d.timer != nil {
		d.timer.Stop()
		d.timer = nil
	}
}

func deskID(d *deskState) string {
	if d == nil {
		return ""
	}
	return d.id
}

// SetDesks gives an owner to the desks in names, by id to the owner's
// configured name, possibly empty: from then on only the owner and the
// owner's guests enter them. Ids that are not desks are ignored. It must be
// called before Run.
func (r *Room) SetDesks(names map[string]string) {
	for _, d := range r.desks {
		if name, ok := names[d.id]; ok {
			d.name, d.locked = name, true
			r.lockDesk(d)
		}
	}
}

func (r *Room) deskRequest(ctx context.Context, q sessionDesk) error {
	return submit(ctx, r, r.deskReqs, q)
}

// claimDesk makes s the owner of its desk unless another identity owns it
// and is online. It returns the desk s owns, whether s came back within the
// desk's grace period and whether the public state of the desk changed.
func (r *Room) claimDesk(s *Session) (d *deskState, returning, changed bool) {
	d = r.byDesk[s.desk]
	if d == nil || !d.locked {
		return nil, false, false
	}
	if d.online && d.ownerID != s.id {
		r.log.Warn("desk owned by another identity", "id", s.id, "desk", d.id, "owner", d.ownerID)
		return nil, false, false
	}
	returning = d.timer != nil && d.ownerID == s.id
	if d.ownerID != s.id {
		r.dropGuests(d)
		d.ownerID = s.id
	}
	changed = !d.online || d.lastName != s.name
	d.online, d.lastName = true, s.name
	d.stopGrace()
	r.lockDesk(d)
	return d, returning, changed
}

// sendDesksOnJoin sends a joining session the desks, its guests when it owns
// one and each invite it holds; nothing on a map without desks.
func (r *Room) sendDesksOnJoin(s *Session, own *deskState) {
	if len(r.desks) == 0 {
		return
	}
	r.sendTo(s, typeDesks, r.desksMsg())
	if own != nil {
		r.sendTo(s, typeDeskGuests, own.guestsMsg(r.members))
	}
	for _, d := range r.desks {
		if _, ok := d.guests[s.id]; ok {
			r.sendTo(s, typeDeskInvite, d.inviteMsg(true))
		}
	}
}

// guestChanged tells the owners online who invited id that it came or went,
// or changed its name.
func (r *Room) guestChanged(id, name string) {
	for _, d := range r.desks {
		if _, ok := d.guests[id]; !ok {
			continue
		}
		if name != "" {
			d.guests[id] = name
		}
		r.sendGuests(d)
	}
}

// leaveDesks starts the grace period of the desk id owns, if any, and tells
// the owners who invited id.
func (r *Room) leaveDesks(id string) {
	changed := false
	for _, d := range r.desks {
		if d.ownerID == id && d.online {
			d.online = false
			r.startGrace(d)
			changed = true
		}
	}
	if changed {
		r.broadcast(typeDesks, r.desksMsg(), "")
	}
	r.guestChanged(id, "")
}

func (r *Room) startGrace(d *deskState) {
	d.stopGrace()
	d.seq++
	e := deskExpiry{id: d.id, seq: d.seq}
	d.timer = time.AfterFunc(r.deskGrace, func() {
		_ = submit(context.Background(), r, r.expiries, e)
	})
}

// handleDeskExpiry closes a desk whose owner did not come back: the guests
// lose their invites and leave the desk.
func (r *Room) handleDeskExpiry(e deskExpiry) {
	d := r.byDesk[e.id]
	if d == nil || d.timer == nil || d.seq != e.seq {
		return
	}
	d.timer = nil
	n := len(d.guests)
	r.dropGuests(d)
	r.lockDesk(d)
	r.log.Info("desk closed", "desk", d.id, "guests", n)
}

// handleDesk invites or uninvites a guest for the owner of the sender's
// desk. Only an online target can be invited, up to maxGuests; inviting a
// guest again or uninviting someone else changes nothing.
func (r *Room) handleDesk(q sessionDesk) {
	from := q.sess.id
	if m, ok := r.members[from]; !ok || m.sess != q.sess {
		return
	}
	d := r.byDesk[q.sess.desk]
	if d == nil || !d.online || d.ownerID != from {
		r.log.Debug("desk request ignored", "id", from, "reason", "not the owner")
		return
	}
	_, invited := d.guests[q.target]
	target, online := r.members[q.target]
	switch {
	case q.invite && invited, !q.invite && !invited:
		return
	case q.invite && !online:
		r.log.Debug("desk request ignored", "id", from, "reason", chatOffline)
		return
	case q.invite && len(d.guests) >= maxGuests:
		r.log.Debug("desk request ignored", "id", from, "reason", "too many guests")
		return
	case q.invite:
		d.guests[q.target] = target.sess.name
	default:
		delete(d.guests, q.target)
	}
	r.lockDesk(d)
	if online {
		r.sendTo(target.sess, typeDeskInvite, d.inviteMsg(q.invite))
	}
	r.sendGuests(d)
	r.log.Debug("desk guests changed", "desk", d.id, "invite", q.invite, "guests", len(d.guests))
}

// dropGuests ends every invite to d, telling the guests online.
func (r *Room) dropGuests(d *deskState) {
	for id := range d.guests {
		if m, ok := r.members[id]; ok {
			r.sendTo(m.sess, typeDeskInvite, d.inviteMsg(false))
		}
	}
	clear(d.guests)
}

// lockDesk lets only the owner and the guests into d; those inside who may
// no longer stay are moved out at once and reported on the next tick.
func (r *Room) lockDesk(d *deskState) {
	ids := make([]string, 0, len(d.guests)+1)
	if d.ownerID != "" {
		ids = append(ids, d.ownerID)
	}
	for id := range d.guests {
		ids = append(ids, id)
	}
	if err := r.space.Lock(d.id, ids...); err != nil {
		r.log.Error("lock desk", "desk", d.id, "err", err)
	}
}

func (r *Room) sendGuests(d *deskState) {
	if m, ok := r.members[d.ownerID]; ok && d.online {
		r.sendTo(m.sess, typeDeskGuests, d.guestsMsg(r.members))
	}
}

func (r *Room) desksMsg() desksMsg {
	out := make([]deskMsg, len(r.desks))
	for i, d := range r.desks {
		out[i] = deskMsg{ID: d.id, Online: d.online, Locked: d.locked}
		if d.locked {
			out[i].Owner = &deskOwnerMsg{ID: d.ownerID, Name: d.ownerName()}
		}
	}
	return desksMsg{Desks: out}
}

func (d *deskState) guestsMsg(members map[string]*member) deskGuestsMsg {
	gs := make([]deskGuestMsg, 0, len(d.guests))
	for id, name := range d.guests {
		_, online := members[id]
		gs = append(gs, deskGuestMsg{ID: id, Name: name, Online: online})
	}
	slices.SortFunc(gs, func(a, b deskGuestMsg) int { return cmp.Compare(a.ID, b.ID) })
	return deskGuestsMsg{Desk: d.id, Guests: gs}
}

func (d *deskState) inviteMsg(invited bool) deskInviteMsg {
	return deskInviteMsg{Desk: d.id, Owner: d.ownerID, OwnerName: d.ownerName(), Invited: invited}
}

func (r *Room) sendTo(s *Session, t string, d any) {
	msg, err := encode(t, d)
	if err != nil {
		r.log.Error("encode", "type", t, "err", err)
		return
	}
	s.send(msg)
}
