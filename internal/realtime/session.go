package realtime

import (
	"cmp"
	"context"
	"io"
	"log/slog"
	"sync"
	"time"

	"github.com/coder/websocket"

	"github.com/victoroliveirabarros/vb-office-32/internal/world"
)

const (
	maxMessageSize = 4 << 10
	sendBuffer     = 64
	pingInterval   = 20 * time.Second
	writeTimeout   = 10 * time.Second

	statusReplaced websocket.StatusCode = 4001

	reasonReplaced     = "replaced"
	reasonSlowConsumer = "slow consumer"
	reasonPingTimeout  = "ping timeout"
)

type closeReason struct {
	code   websocket.StatusCode
	reason string
}

// level separates anomalies from routine closes. Every 1008 close is either
// a protocol error or a slow consumer.
func (c closeReason) level() slog.Level {
	switch {
	case c.code == websocket.StatusPolicyViolation, c.reason == reasonPingTimeout:
		return slog.LevelWarn
	case c.code == statusReplaced:
		return slog.LevelInfo
	}
	return slog.LevelDebug
}

// Session is one WebSocket connection. Its send side never blocks: a full
// buffer closes the connection instead of stalling the room.
type Session struct {
	id   string
	name string
	conn *websocket.Conn
	room *Room
	log  *slog.Logger

	out       chan []byte
	done      chan struct{}
	ended     chan struct{}
	closeOnce sync.Once
	closeWith closeReason
}

func newSession(id, name string, conn *websocket.Conn, room *Room, log *slog.Logger) *Session {
	return &Session{
		id:    id,
		name:  name,
		conn:  conn,
		room:  room,
		log:   log,
		out:   make(chan []byte, sendBuffer),
		done:  make(chan struct{}),
		ended: make(chan struct{}),
	}
}

func (s *Session) send(msg []byte) {
	select {
	case <-s.done:
	case s.out <- msg:
	default:
		s.close(websocket.StatusPolicyViolation, reasonSlowConsumer)
	}
}

func (s *Session) close(code websocket.StatusCode, reason string) {
	s.closeOnce.Do(func() {
		s.closeWith = closeReason{code, reason}
		close(s.done)
	})
}

func (s *Session) run(ctx context.Context) {
	defer close(s.ended)
	var wg sync.WaitGroup
	wg.Go(func() { s.writeLoop(ctx) })
	wg.Go(func() { s.pingLoop(ctx) })

	readErr := s.readLoop(ctx)
	s.close(websocket.StatusNormalClosure, "")
	wg.Wait()

	c := s.closeWith
	attrs := []any{"code", int(c.code), "reason", cmp.Or(c.reason, "normal")}
	if readErr != nil {
		attrs = append(attrs, "err", readErr)
	}
	s.log.Log(ctx, c.level(), "session closed", attrs...)
}

func (s *Session) readLoop(ctx context.Context) error {
	for {
		typ, r, err := s.conn.Reader(ctx)
		if err != nil {
			return err
		}
		if typ != websocket.MessageText {
			s.close(websocket.StatusPolicyViolation, "text messages only")
			return nil
		}
		b, err := io.ReadAll(io.LimitReader(r, maxMessageSize+1))
		if err != nil {
			return err
		}
		if len(b) > maxMessageSize {
			s.close(websocket.StatusPolicyViolation, "message too big")
			return nil
		}

		msg, err := decodeClient(b)
		if err != nil {
			s.log.Debug("invalid message", "err", err)
			s.close(websocket.StatusPolicyViolation, "invalid message")
			return nil
		}
		switch m := msg.(type) {
		case moveMsg:
			if err := s.room.input(ctx, s, world.Input{Seq: m.Seq, Dir: m.Dir}); err != nil {
				return err
			}
		case pingMsg:
			pong, err := encode(typePong, m)
			if err != nil {
				return err
			}
			s.send(pong)
		}
	}
}

func (s *Session) writeLoop(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			s.conn.CloseNow()
			return
		case <-s.done:
			s.conn.Close(s.closeWith.code, s.closeWith.reason)
			return
		case msg := <-s.out:
			wctx, cancel := context.WithTimeout(ctx, writeTimeout)
			err := s.conn.Write(wctx, websocket.MessageText, msg)
			cancel()
			if err != nil {
				s.conn.CloseNow()
				return
			}
		}
	}
}

func (s *Session) pingLoop(ctx context.Context) {
	t := time.NewTicker(pingInterval)
	defer t.Stop()
	for {
		select {
		case <-s.done:
			return
		case <-t.C:
			pctx, cancel := context.WithTimeout(ctx, writeTimeout)
			err := s.conn.Ping(pctx)
			cancel()
			if err != nil {
				s.close(websocket.StatusGoingAway, reasonPingTimeout)
				return
			}
		}
	}
}
