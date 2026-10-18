package realtime

import (
	"cmp"
	"context"
	"errors"
	"io"
	"log/slog"
	"sync"
	"time"

	"github.com/coder/websocket"

	"github.com/victoroliveirabarros/vb-office-32/internal/auth"
	"github.com/victoroliveirabarros/vb-office-32/internal/chat"
	"github.com/victoroliveirabarros/vb-office-32/internal/world"
)

const (
	maxMessageSize = 8 << 10
	sendBuffer     = 64
	pingInterval   = 20 * time.Second
	writeTimeout   = 10 * time.Second

	statusReplaced websocket.StatusCode = 4001
	statusExpired  websocket.StatusCode = 4002

	reasonReplaced     = "replaced"
	reasonExpired      = "session expired"
	reasonSlowConsumer = "slow consumer"
	reasonPingTimeout  = "ping timeout"
	reasonRateLimit    = "rate limit"
	reasonRestarting   = "server restarting"
)

type closeReason struct {
	code   websocket.StatusCode
	reason string
}

// level separates anomalies from routine closes. Every 1008 close is a
// protocol error, a slow consumer or a rate limit.
func (c closeReason) level() slog.Level {
	switch {
	case c.code == websocket.StatusPolicyViolation, c.reason == reasonPingTimeout:
		return slog.LevelWarn
	case c.code == statusReplaced, c.code == statusExpired:
		return slog.LevelInfo
	}
	return slog.LevelDebug
}

// Session is one WebSocket connection. Its send side never blocks: a full
// buffer closes the connection instead of stalling the room.
type Session struct {
	id      string
	name    string
	expires time.Time
	conn    *websocket.Conn
	room    *Room
	log     *slog.Logger

	limiter     tokenBucket
	chatLimiter tokenBucket
	out         chan []byte
	done        chan struct{}
	ended       chan struct{}
	closeOnce   sync.Once
	closeWith   closeReason
}

func newSession(id auth.Identity, conn *websocket.Conn, room *Room, log *slog.Logger) *Session {
	return &Session{
		id:          id.ID,
		name:        id.Name,
		expires:     id.Expires,
		conn:        conn,
		room:        room,
		log:         log,
		limiter:     newTokenBucket(messageRate, messageBurst),
		chatLimiter: newTokenBucket(chatRate, chatBurst),
		out:         make(chan []byte, sendBuffer),
		done:        make(chan struct{}),
		ended:       make(chan struct{}),
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
	if !s.expires.IsZero() {
		t := time.AfterFunc(time.Until(s.expires), func() { s.close(statusExpired, reasonExpired) })
		defer t.Stop()
	}
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
		if !s.limiter.allow(time.Now()) {
			s.close(websocket.StatusPolicyViolation, reasonRateLimit)
			return nil
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
		case chatIn:
			reason, err := s.chat(ctx, m, time.Now())
			if err != nil {
				return err
			}
			if reason != "" {
				s.log.Debug("chat rejected", "reason", reason)
				s.sendChatError(m.CID, reason)
			}
		}
	}
}

// chat validates, cleans and rate-limits a chat before the room routes it,
// so the room goroutine never spends time on text. Only a valid chat spends
// a chat token.
func (s *Session) chat(ctx context.Context, m chatIn, now time.Time) (string, error) {
	if !m.valid(s.id) {
		return chatInvalid, nil
	}
	text, err := chat.Clean(m.Text)
	switch {
	case errors.Is(err, chat.ErrEmpty):
		return chatEmpty, nil
	case errors.Is(err, chat.ErrTooLong):
		return chatTooLong, nil
	}
	if !s.chatLimiter.allow(now) {
		return chatRateLimited, nil
	}
	c := sessionChat{sess: s, cid: m.CID, scope: m.Scope, text: text}
	if m.To != nil {
		c.to = *m.To
	}
	return "", s.room.chat(ctx, c)
}

func (s *Session) sendChatError(cid, reason string) {
	msg, err := encode(typeChatError, chatErrorMsg{CID: cid, Reason: reason})
	if err != nil {
		s.log.Error("encode chat error", "err", err)
		return
	}
	s.send(msg)
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
