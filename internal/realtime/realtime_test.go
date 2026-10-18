package realtime

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/victoroliveirabarros/vb-office-32/internal/auth"
	"github.com/victoroliveirabarros/vb-office-32/internal/tilemap"
	"github.com/victoroliveirabarros/vb-office-32/internal/world"
)

// startServer serves testdata/small.tmj, a 4x2 map with a wall at (2,0) and
// spawns at (0,0) and (0,1).
func startServer(t *testing.T) string {
	t.Helper()
	m, err := tilemap.LoadFile("testdata/small.tmj")
	if err != nil {
		t.Fatal(err)
	}
	log := slog.New(slog.DiscardHandler)
	hub := NewHub(NewRoom(DefaultSpace, "small", world.NewSpace(m), log))

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- hub.Run(ctx) }()

	srv := httptest.NewServer(NewHandler(hub, auth.Guest{}, nil, log))
	t.Cleanup(func() {
		cancel()
		if err := <-done; err != nil {
			t.Errorf("hub: %v", err)
		}
		srv.Close()
	})
	return "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws"
}

type client struct {
	t    *testing.T
	conn *websocket.Conn
}

func dial(t *testing.T, url, name string) *client {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, url+"?name="+name, nil)
	if err != nil {
		t.Fatalf("dial %s: %v", name, err)
	}
	t.Cleanup(func() { conn.CloseNow() })
	return &client{t: t, conn: conn}
}

func (c *client) send(typ string, d any) {
	c.t.Helper()
	b, err := encode(typ, d)
	if err != nil {
		c.t.Fatal(err)
	}
	if err := c.conn.Write(context.Background(), websocket.MessageText, b); err != nil {
		c.t.Fatalf("write %s: %v", typ, err)
	}
}

func (c *client) read() (envelope, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_, b, err := c.conn.Read(ctx)
	if err != nil {
		return envelope{}, err
	}
	var env envelope
	if err := json.Unmarshal(b, &env); err != nil {
		c.t.Fatalf("decode %s: %v", b, err)
	}
	return env, nil
}

// expect skips messages until one of type typ decodes into v and satisfies ok.
func expect[T any](c *client, typ string, ok func(T) bool) T {
	c.t.Helper()
	for {
		env, err := c.read()
		if err != nil {
			c.t.Fatalf("waiting for %s: %v", typ, err)
		}
		if env.T != typ {
			continue
		}
		var v T
		if err := json.Unmarshal(env.D, &v); err != nil {
			c.t.Fatalf("decode %s: %v", typ, err)
		}
		if ok == nil || ok(v) {
			return v
		}
	}
}

func (c *client) expectClose(code websocket.StatusCode) {
	c.t.Helper()
	for {
		_, err := c.read()
		if err == nil {
			continue
		}
		if got := websocket.CloseStatus(err); got != code {
			c.t.Fatalf("close status = %d (%v), want %d", got, err, code)
		}
		return
	}
}

type stateMsg struct {
	Tick    uint64   `json:"tick"`
	Ack     uint32   `json:"ack"`
	Players []posMsg `json:"players"`
}

func hasPos(want posMsg) func(stateMsg) bool {
	return func(s stateMsg) bool { return slices.Contains(s.Players, want) }
}

func ackAtLeast(seq uint32) func(stateMsg) bool {
	return func(s stateMsg) bool { return s.Ack >= seq }
}

func TestSessionLifecycle(t *testing.T) {
	url := startServer(t)

	ana := dial(t, url, "Ana")
	w := expect[welcomeMsg](ana, typeWelcome, nil)
	wantAna := playerMsg{ID: "guest:ana", Name: "Ana", X: 0, Y: 0, Dir: world.Down}
	if w.SelfID != "guest:ana" || w.MapID != "small" || w.TickRate != 20 || w.StepMs != 150 {
		t.Errorf("welcome = %+v", w)
	}
	if len(w.Players) != 1 || w.Players[0] != wantAna {
		t.Errorf("welcome players = %+v, want [%+v]", w.Players, wantAna)
	}

	bob := dial(t, url, "bob")
	w = expect[welcomeMsg](bob, typeWelcome, nil)
	if len(w.Players) != 2 {
		t.Errorf("bob welcome players = %+v, want 2", w.Players)
	}
	joined := expect[playerMsg](ana, typeJoined, nil)
	if want := (playerMsg{ID: "guest:bob", Name: "bob", X: 0, Y: 1, Dir: world.Down}); joined != want {
		t.Errorf("joined = %+v, want %+v", joined, want)
	}

	ana.send(typeMove, moveMsg{Seq: 1, Dir: world.Right})
	moved := posMsg{ID: "guest:ana", X: 1, Y: 0, Dir: world.Right}
	if s := expect(ana, typeState, ackAtLeast(1)); s.Ack != 1 || !hasPos(moved)(s) {
		t.Errorf("ana state = %+v, want ack 1 and %+v", s, moved)
	}
	if s := expect(bob, typeState, hasPos(moved)); s.Ack != 0 {
		t.Errorf("bob ack = %d, want 0", s.Ack)
	}

	ana.send(typeMove, moveMsg{Seq: 2, Dir: world.Up})
	ana.send(typeMove, moveMsg{Seq: 3, Dir: world.Right})

	up := expect(ana, typeState, ackAtLeast(2))
	wall := expect(ana, typeState, ackAtLeast(3))
	if want := (posMsg{ID: "guest:ana", X: 1, Y: 0, Dir: world.Up}); !hasPos(want)(up) {
		t.Errorf("after map edge: %+v, want %+v", up, want)
	}
	if want := (posMsg{ID: "guest:ana", X: 1, Y: 0, Dir: world.Right}); !hasPos(want)(wall) {
		t.Errorf("after wall: %+v, want %+v", wall, want)
	}
	if gap := (wall.Tick - up.Tick) * uint64(world.TickInterval); time.Duration(gap) < world.StepCooldown-world.TickInterval/2 {
		t.Errorf("second step applied %v after the first, want cooldown %v", time.Duration(gap), world.StepCooldown)
	}

	bob.send(typePing, pingMsg{TS: 1234.5})
	if p := expect[pingMsg](bob, typePong, nil); p.TS != 1234.5 {
		t.Errorf("pong ts = %v, want 1234.5", p.TS)
	}

	ana.conn.Close(websocket.StatusNormalClosure, "")
	if l := expect[leftMsg](bob, typeLeft, nil); l.ID != "guest:ana" {
		t.Errorf("left = %+v, want guest:ana", l)
	}

	ana = dial(t, url, "Ana")
	w = expect[welcomeMsg](ana, typeWelcome, nil)
	wantAna = playerMsg{ID: "guest:ana", Name: "Ana", X: 1, Y: 0, Dir: world.Right}
	if !slices.Contains(w.Players, wantAna) {
		t.Errorf("welcome players = %+v, want %+v", w.Players, wantAna)
	}
	expect(bob, typeJoined, func(p playerMsg) bool { return p == wantAna })

	ana.send(typeMove, moveMsg{Seq: 1, Dir: world.Down})
	if s := expect(ana, typeState, ackAtLeast(1)); s.Ack != 1 {
		t.Errorf("ack after reconnect = %d, want 1 (seq restarts per connection)", s.Ack)
	}

	second := dial(t, url, "ANA")
	w = expect[welcomeMsg](second, typeWelcome, nil)
	if w.SelfID != "guest:ana" {
		t.Errorf("selfId = %q, want guest:ana", w.SelfID)
	}
	ana.expectClose(statusReplaced)

	second.send(typeMove, moveMsg{Seq: 1, Dir: world.Up})
	if s := expect(second, typeState, ackAtLeast(1)); s.Ack != 1 {
		t.Errorf("ack on new session = %d, want 1", s.Ack)
	}
}

func TestReplacedWithNewNameBroadcastsJoined(t *testing.T) {
	url := startServer(t)

	bob := dial(t, url, "bob")
	expect[welcomeMsg](bob, typeWelcome, nil)
	ana := dial(t, url, "Ana")
	expect[welcomeMsg](ana, typeWelcome, nil)
	expect(bob, typeJoined, func(p playerMsg) bool { return p.Name == "Ana" })

	same := dial(t, url, "Ana")
	expect[welcomeMsg](same, typeWelcome, nil)
	ana.expectClose(statusReplaced)

	renamed := dial(t, url, "ANA")
	w := expect[welcomeMsg](renamed, typeWelcome, nil)
	same.expectClose(statusReplaced)
	if !slices.ContainsFunc(w.Players, func(p playerMsg) bool { return p.ID == "guest:ana" && p.Name == "ANA" }) {
		t.Errorf("welcome players = %+v, want guest:ana named ANA", w.Players)
	}

	// The room handles joins in order, so a joined from the same-name
	// replacement would arrive first.
	if p := expect[playerMsg](bob, typeJoined, nil); p.ID != "guest:ana" || p.Name != "ANA" {
		t.Errorf("joined = %+v, want guest:ana named ANA", p)
	}
}

func TestPolicyViolations(t *testing.T) {
	url := startServer(t)
	tests := []struct {
		name string
		msg  string
	}{
		{"too big", `{"t":"ping","d":{"ts":1},"pad":"` + strings.Repeat("x", maxMessageSize) + `"}`},
		{"malformed", `{"t":`},
		{"unknown type", `{"t":"dance","d":{}}`},
		{"bad dir", `{"t":"move","d":{"seq":1,"dir":"north"}}`},
		{"negative seq", `{"t":"move","d":{"seq":-1,"dir":"up"}}`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			c := dial(t, url, "carol")
			expect[welcomeMsg](c, typeWelcome, nil)
			if err := c.conn.Write(context.Background(), websocket.MessageText, []byte(tt.msg)); err != nil {
				t.Fatal(err)
			}
			c.expectClose(websocket.StatusPolicyViolation)
		})
	}
}

func TestInvalidNameRejectedBeforeUpgrade(t *testing.T) {
	url := startServer(t)
	_, resp, err := websocket.Dial(context.Background(), url+"?name=bad!", nil)
	if err == nil {
		t.Fatal("dial succeeded, want error")
	}
	if resp == nil || resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("response = %v, want 400", resp)
	}
}

func TestSlowConsumerIsClosed(t *testing.T) {
	s := newSession("guest:x", "x", nil, nil, slog.New(slog.DiscardHandler))
	for range sendBuffer {
		s.send([]byte("{}"))
	}
	select {
	case <-s.done:
		t.Fatal("closed before buffer was full")
	default:
	}

	s.send([]byte("{}"))
	select {
	case <-s.done:
	default:
		t.Fatal("session still open after buffer overflow")
	}
	if want := (closeReason{websocket.StatusPolicyViolation, "slow consumer"}); s.closeWith != want {
		t.Errorf("close = %+v, want %+v", s.closeWith, want)
	}
}

func TestCloseReasonLevel(t *testing.T) {
	tests := []struct {
		close closeReason
		want  slog.Level
	}{
		{closeReason{websocket.StatusPolicyViolation, reasonSlowConsumer}, slog.LevelWarn},
		{closeReason{websocket.StatusPolicyViolation, "invalid message"}, slog.LevelWarn},
		{closeReason{websocket.StatusGoingAway, reasonPingTimeout}, slog.LevelWarn},
		{closeReason{statusReplaced, reasonReplaced}, slog.LevelInfo},
		{closeReason{websocket.StatusGoingAway, "server shutting down"}, slog.LevelDebug},
		{closeReason{websocket.StatusNormalClosure, ""}, slog.LevelDebug},
	}
	for _, tt := range tests {
		if got := tt.close.level(); got != tt.want {
			t.Errorf("%+v: level = %v, want %v", tt.close, got, tt.want)
		}
	}
}

func TestEncodeState(t *testing.T) {
	got := encodeState(7, 3, []byte(`[{"id":"a","x":1,"y":2,"dir":"up"}]`))
	var env envelope
	if err := json.Unmarshal(got, &env); err != nil {
		t.Fatalf("invalid json %s: %v", got, err)
	}
	var s stateMsg
	if err := json.Unmarshal(env.D, &s); err != nil {
		t.Fatal(err)
	}
	want := stateMsg{Tick: 7, Ack: 3, Players: []posMsg{{ID: "a", X: 1, Y: 2, Dir: world.Up}}}
	if env.T != typeState || s.Tick != want.Tick || s.Ack != want.Ack || len(s.Players) != 1 || s.Players[0] != want.Players[0] {
		t.Errorf("state = %s %+v, want %+v", env.T, s, want)
	}
}

func TestDecodeClient(t *testing.T) {
	msg, err := decodeClient([]byte(`{"t":"move","d":{"seq":4294967295,"dir":"left"}}`))
	if err != nil {
		t.Fatal(err)
	}
	if want := (moveMsg{Seq: 4294967295, Dir: world.Left}); msg != want {
		t.Errorf("decoded %+v, want %+v", msg, want)
	}
	if _, err := decodeClient([]byte(`{"t":"move","d":{"seq":4294967296,"dir":"left"}}`)); !errors.Is(err, errInvalidMessage) {
		t.Errorf("seq overflow: err = %v, want %v", err, errInvalidMessage)
	}
}
