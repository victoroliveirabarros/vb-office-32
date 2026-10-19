package realtime

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"sync"
	"time"

	"github.com/coder/websocket"

	"github.com/victoroliveirabarros/vb-office-32/internal/chat"
	"github.com/victoroliveirabarros/vb-office-32/internal/media"
	"github.com/victoroliveirabarros/vb-office-32/internal/world"
)

const (
	shutdownTimeout = 5 * time.Second
	// mediaCheck is how often grants due for renewal are reissued and the
	// media room is reconciled with the members.
	mediaCheck = time.Minute
	// removeGrace is how long an identity that left keeps its media
	// connection, so a reconnecting WebSocket does not drop the call.
	removeGrace = 30 * time.Second
	chatBuffer  = 64
)

var errRoomClosed = errors.New("room closed")

// Media grants and revokes access to the media server; a nil Media turns
// media off.
type Media interface {
	Issue(identity, name, room string, now time.Time) (media.Grant, error)
	Remove(ctx context.Context, room, identity string) (bool, error)
	Participants(ctx context.Context, room string) ([]string, error)
}

type member struct {
	sess *Session
	ack  uint32
	// renewAt is when the member gets a fresh media grant.
	renewAt time.Time
}

// removal is a media removal scheduled for an identity that left; seq tells
// a stale timer from the current one.
type removal struct {
	id    string
	seq   uint64
	timer *time.Timer
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
	media Media
	log   *slog.Logger

	joins    chan *Session
	leaves   chan *Session
	inputs   chan sessionInput
	chats    chan sessionChat
	removals chan removal
	listed   chan []string
	arrived  chan string
	removed  chan string
	done     chan struct{}
	members  map[string]*member

	pending    map[string]removal
	seq        uint64
	listing    bool
	removing   sync.WaitGroup
	checkEvery time.Duration

	ids     *chat.IDs
	history chat.History
	// historyMsg caches the encoded chatHistory until the next everyone
	// message.
	historyMsg []byte
}

func NewRoom(id, mapID string, space *world.Space, mi Media, log *slog.Logger) *Room {
	return &Room{
		id:       id,
		mapID:    mapID,
		space:    space,
		media:    mi,
		log:      log.With("room", id),
		joins:    make(chan *Session),
		leaves:   make(chan *Session),
		inputs:   make(chan sessionInput, 256),
		chats:    make(chan sessionChat, chatBuffer),
		removals: make(chan removal),
		listed:   make(chan []string),
		arrived:  make(chan string),
		removed:  make(chan string),
		done:     make(chan struct{}),
		members:  make(map[string]*member),
		pending:  make(map[string]removal),

		checkEvery: mediaCheck,
		ids:        chat.NewIDs(),
	}
}

func (r *Room) Run(ctx context.Context) error {
	defer close(r.done)
	ticker := time.NewTicker(world.TickInterval)
	defer ticker.Stop()
	var check <-chan time.Time
	if r.media != nil {
		t := time.NewTicker(r.checkEvery)
		defer t.Stop()
		check = t.C
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
		case c := <-r.chats:
			r.handleChat(c)
		case rm := <-r.removals:
			r.handleRemoval(ctx, rm)
		case ids := <-r.listed:
			r.handleListed(ctx, ids)
		case id := <-r.arrived:
			r.handleArrived(ctx, id)
		case id := <-r.removed:
			r.handleRemoved(id)
		case now := <-ticker.C:
			r.tick(now)
		case now := <-check:
			r.checkMedia(ctx, now)
		}
	}
}

// shutdown closes every session and waits, bounded, for their close
// handshakes so clients see 1001 instead of a dropped connection. Nobody is
// removed from media: the clients reconnect to the next process.
func (r *Room) shutdown() {
	for id := range r.pending {
		r.cancelRemoval(id)
	}
	defer r.removing.Wait()
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
	r.cancelRemoval(s.id)
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
	}
	r.sendNearby(s, r.space.Nearby(s.id))
	r.sendHistory(s)
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
	if r.media != nil {
		r.scheduleRemoval(s.id)
	}
}

// scheduleRemoval revokes the media connection of an identity that does not
// come back within removeGrace: LiveKit renews the token of a connected
// participant by itself, so leaving the game alone would not end the call.
func (r *Room) scheduleRemoval(id string) {
	r.cancelRemoval(id)
	r.seq++
	seq := r.seq
	t := time.AfterFunc(removeGrace, func() {
		_ = submit(context.Background(), r, r.removals, removal{id: id, seq: seq})
	})
	r.pending[id] = removal{id: id, seq: seq, timer: t}
}

func (r *Room) cancelRemoval(id string) {
	if rm, ok := r.pending[id]; ok {
		rm.timer.Stop()
		delete(r.pending, id)
	}
}

func (r *Room) handleRemoval(ctx context.Context, rm removal) {
	if p, ok := r.pending[rm.id]; !ok || p.seq != rm.seq {
		return
	}
	delete(r.pending, rm.id)
	r.remove(ctx, rm.id)
}

// checkMedia renews the grants due and lists the media room, one list at a
// time: a removed client may join again with a token it still holds.
func (r *Room) checkMedia(ctx context.Context, now time.Time) {
	r.renewMedia(now)
	if r.listing {
		return
	}
	r.listing = true
	r.removing.Go(func() {
		ids, err := r.media.Participants(ctx, r.id)
		if err != nil && ctx.Err() == nil {
			r.log.Warn("list media participants failed", "err", err)
		}
		_ = submit(ctx, r, r.listed, ids)
	})
}

// handleListed removes every identity in the media room that is neither a
// member nor within its grace period, ours or not. It decides on the members
// of now, not of when the list was asked for.
func (r *Room) handleListed(ctx context.Context, ids []string) {
	r.listing = false
	for _, id := range ids {
		if r.stale(id) {
			r.log.Info("stale media participant", "id", id)
			r.remove(ctx, id)
		}
	}
}

// mediaArrived reports that identity became active in the media room.
func (r *Room) mediaArrived(ctx context.Context, id string) error {
	return submit(ctx, r, r.arrived, id)
}

func (r *Room) handleArrived(ctx context.Context, id string) {
	if r.media != nil && r.stale(id) {
		r.log.Info("media participant without session", "id", id)
		r.remove(ctx, id)
	}
}

func (r *Room) stale(id string) bool {
	_, member := r.members[id]
	_, pending := r.pending[id]
	return !member && !pending
}

// remove runs the call outside the room goroutine so a slow media server
// never delays a tick.
func (r *Room) remove(ctx context.Context, id string) {
	r.removing.Go(func() {
		found, err := r.media.Remove(ctx, r.id, id)
		switch {
		case found:
			r.log.Info("removed from media", "id", id)
		case err == nil:
			r.log.Debug("already gone from media", "id", id)
		case ctx.Err() == nil:
			r.log.Warn("media removal failed", "id", id, "err", err)
		}
		_ = submit(ctx, r, r.removed, id)
	})
}

// handleRemoved hands a new grant to an identity that came back while its
// removal was in flight, since that removal may have dropped the new media
// connection.
func (r *Room) handleRemoved(id string) {
	if m, ok := r.members[id]; ok {
		r.log.Info("media reissued after removal", "id", id)
		r.sendMedia(m, time.Now())
	}
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
	for id, ids := range d.Nearby {
		if m, ok := r.members[id]; ok {
			r.sendNearby(m.sess, ids)
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
