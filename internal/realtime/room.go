package realtime

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"time"

	"github.com/coder/websocket"

	"github.com/victoroliveirabarros/vb-office-32/internal/media"
	"github.com/victoroliveirabarros/vb-office-32/internal/world"
)

const (
	shutdownTimeout = 5 * time.Second
	mediaCheck      = time.Minute
)

var errRoomClosed = errors.New("room closed")

// MediaIssuer grants access to the media server; a nil MediaIssuer turns
// media off.
type MediaIssuer interface {
	Issue(identity, name, room string, now time.Time) (media.Grant, error)
}

type member struct {
	sess *Session
	ack  uint32
	// renewAt is when the member gets a fresh media grant.
	renewAt time.Time
}

type sessionInput struct {
	sess *Session
	in   world.Input
}

// Room is an actor: a single goroutine (Run) owns the world.Space and all
// member state, so none of it needs locking.
type Room struct {
	id    string
	mapID string
	space *world.Space
	media MediaIssuer
	log   *slog.Logger

	// mediaCheck is how often grants due for renewal are reissued.
	mediaCheck time.Duration

	joins   chan *Session
	leaves  chan *Session
	inputs  chan sessionInput
	done    chan struct{}
	members map[string]*member
}

func NewRoom(id, mapID string, space *world.Space, mi MediaIssuer, log *slog.Logger) *Room {
	return &Room{
		id:         id,
		mapID:      mapID,
		space:      space,
		media:      mi,
		log:        log.With("room", id),
		mediaCheck: mediaCheck,
		joins:      make(chan *Session),
		leaves:     make(chan *Session),
		inputs:     make(chan sessionInput, 256),
		done:       make(chan struct{}),
		members:    make(map[string]*member),
	}
}

func (r *Room) Run(ctx context.Context) error {
	defer close(r.done)
	ticker := time.NewTicker(world.TickInterval)
	defer ticker.Stop()
	var renew <-chan time.Time
	if r.media != nil {
		t := time.NewTicker(r.mediaCheck)
		defer t.Stop()
		renew = t.C
	}

	for {
		select {
		case <-ctx.Done():
			r.shutdown()
			return nil
		case s := <-r.joins:
			r.handleJoin(s)
		case s := <-r.leaves:
			r.handleLeave(s)
		case in := <-r.inputs:
			r.handleInput(in)
		case now := <-ticker.C:
			r.tick(now)
		case now := <-renew:
			r.renewMedia(now)
		}
	}
}

// shutdown closes every session and waits, bounded, for their close
// handshakes so clients see 1001 instead of a dropped connection.
func (r *Room) shutdown() {
	for _, m := range r.members {
		m.sess.close(websocket.StatusGoingAway, reasonRestarting)
	}
	timeout := time.After(shutdownTimeout)
	for _, m := range r.members {
		select {
		case <-m.sess.ended:
		case <-timeout:
			r.log.Warn("shutdown timed out waiting for sessions")
			return
		}
	}
}

func (r *Room) join(ctx context.Context, s *Session) error {
	return submit(ctx, r, r.joins, s)
}

func (r *Room) leave(s *Session) {
	_ = submit(context.Background(), r, r.leaves, s)
}

func (r *Room) input(ctx context.Context, s *Session, in world.Input) error {
	return submit(ctx, r, r.inputs, sessionInput{s, in})
}

func submit[T any](ctx context.Context, r *Room, ch chan<- T, v T) error {
	select {
	case ch <- v:
		return nil
	case <-r.done:
		return errRoomClosed
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (r *Room) handleJoin(s *Session) {
	old, replaced := r.members[s.id]
	if replaced {
		old.sess.close(statusReplaced, reasonReplaced)
	}
	self := r.space.Join(s.id, s.name)
	m := &member{sess: s}
	r.members[s.id] = m

	players := r.space.Players()
	msgs := make([]playerMsg, len(players))
	for i, p := range players {
		msgs[i] = newPlayerMsg(p)
	}
	welcome, err := encode(typeWelcome, welcomeMsg{
		SelfID:   s.id,
		MapID:    r.mapID,
		TickRate: world.TickRate,
		StepMs:   world.StepCooldown.Milliseconds(),
		Players:  msgs,
	})
	if err != nil {
		r.log.Error("encode welcome", "err", err)
		s.close(websocket.StatusInternalError, "")
		return
	}
	s.send(welcome)
	if r.media != nil {
		r.sendMedia(m, time.Now())
		r.sendNearby(s, r.space.Nearby(s.id))
	}
	r.log.Info("player joined", "id", s.id, "replaced", replaced)

	if !replaced || old.sess.name != s.name {
		r.broadcast(typeJoined, newPlayerMsg(self), s.id)
	}
}

func (r *Room) handleLeave(s *Session) {
	if m, ok := r.members[s.id]; !ok || m.sess != s {
		return
	}
	delete(r.members, s.id)
	r.space.Leave(s.id)
	r.log.Info("player left", "id", s.id)
	r.broadcast(typeLeft, leftMsg{ID: s.id}, "")
}

func (r *Room) handleInput(in sessionInput) {
	if m, ok := r.members[in.sess.id]; !ok || m.sess != in.sess {
		return
	}
	if err := r.space.Enqueue(in.sess.id, in.in); err != nil {
		r.log.Debug("input dropped", "id", in.sess.id, "seq", in.in.Seq, "err", err)
	}
}

func (r *Room) tick(now time.Time) {
	d := r.space.Step(now)
	if len(d.Moved) > 0 || len(d.Acks) > 0 {
		r.sendState(d)
	}
	if r.media != nil {
		for id, ids := range d.Nearby {
			if m, ok := r.members[id]; ok {
				r.sendNearby(m.sess, ids)
			}
		}
	}
}

func (r *Room) sendState(d world.Delta) {
	positions := make([]posMsg, len(d.Moved))
	for i, p := range d.Moved {
		positions[i] = posMsg{ID: p.ID, X: p.Pos.X, Y: p.Pos.Y, Dir: p.Dir}
	}
	raw, err := json.Marshal(positions)
	if err != nil {
		r.log.Error("encode positions", "err", err)
		return
	}

	for id, m := range r.members {
		if ack, ok := d.Acks[id]; ok {
			m.ack = ack
		} else if len(d.Moved) == 0 {
			continue
		}
		m.sess.send(encodeState(d.Tick, m.ack, raw))
	}
}

func (r *Room) renewMedia(now time.Time) {
	for _, m := range r.members {
		if !now.Before(m.renewAt) {
			r.sendMedia(m, now)
		}
	}
}

// sendMedia issues a grant and schedules its renewal halfway through its
// lifetime. The token is never logged.
func (r *Room) sendMedia(m *member, now time.Time) {
	g, err := r.media.Issue(m.sess.id, m.sess.name, r.id, now)
	if err != nil {
		r.log.Error("issue media grant", "id", m.sess.id, "err", err)
		return
	}
	msg, err := encode(typeMedia, mediaMsg{URL: g.URL, Token: g.Token, ExpiresAt: g.ExpiresAt.UnixMilli()})
	if err != nil {
		r.log.Error("encode media", "err", err)
		return
	}
	m.renewAt = now.Add(g.ExpiresAt.Sub(now) / 2)
	m.sess.send(msg)
}

func (r *Room) sendNearby(s *Session, ids []string) {
	msg, err := encode(typeNearby, nearbyMsg{IDs: ids})
	if err != nil {
		r.log.Error("encode nearby", "err", err)
		return
	}
	s.send(msg)
}

func (r *Room) broadcast(t string, d any, except string) {
	msg, err := encode(t, d)
	if err != nil {
		r.log.Error("encode broadcast", "type", t, "err", err)
		return
	}
	for id, m := range r.members {
		if id != except {
			m.sess.send(msg)
		}
	}
}
