package realtime

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"maps"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"testing/synctest"
	"time"

	"github.com/coder/websocket"

	"github.com/victoroliveirabarros/vb-office-32/internal/auth"
	"github.com/victoroliveirabarros/vb-office-32/internal/chat"
	"github.com/victoroliveirabarros/vb-office-32/internal/tilemap"
	"github.com/victoroliveirabarros/vb-office-32/internal/world"
)

// serveLine serves testdata/line.tmj, a 12x1 open map with spawns at x = 0,
// 3 and 11: the first two players are near, the third far from both.
func serveLine(t *testing.T, log *slog.Logger) string {
	t.Helper()
	return serveMap(t, "line", auth.Guest{}, 10, nil, log)
}

// joinLine connects Ana, Bob and Carol in spawn order and waits until Ana
// and Bob are near each other.
func joinLine(t *testing.T, url string) (ana, bob, carol *client) {
	t.Helper()
	ana = dial(t, url, "Ana")
	expect[welcomeMsg](ana, typeWelcome, nil)
	bob = dial(t, url, "Bob")
	expect[welcomeMsg](bob, typeWelcome, nil)
	carol = dial(t, url, "Carol")
	expect[welcomeMsg](carol, typeWelcome, nil)
	expect(ana, typeNearby, nearbyIs("guest:bob"))
	expect(bob, typeNearby, nearbyIs("guest:ana"))
	return ana, bob, carol
}

// chat sends a chat; an empty to is left out.
func (c *client) chat(cid string, scope chat.Scope, to, text string) {
	c.t.Helper()
	d := map[string]any{"cid": cid, "scope": scope, "text": text}
	if to != "" {
		d["to"] = to
	}
	c.send(typeChat, d)
}

func (c *client) sendRaw(msg string) {
	c.t.Helper()
	if err := c.conn.Write(context.Background(), websocket.MessageText, []byte(msg)); err != nil {
		c.t.Fatalf("write: %v", err)
	}
}

// nextChat returns the next chat or chatError, skipping movement and
// presence.
func nextChat(c *client) envelope {
	c.t.Helper()
	for {
		env, err := c.read()
		if err != nil {
			c.t.Fatalf("waiting for a chat: %v", err)
		}
		if env.T == typeChat || env.T == typeChatError {
			return env
		}
	}
}

// readChat returns the next chat and its sorted keys.
func readChat(c *client) (chatOut, []string) {
	c.t.Helper()
	env := nextChat(c)
	if env.T != typeChat {
		c.t.Fatalf("got %s %s, want chat", env.T, env.D)
	}
	var keys map[string]json.RawMessage
	if err := json.Unmarshal(env.D, &keys); err != nil {
		c.t.Fatal(err)
	}
	return decode[chatOut](c.t, env), slices.Sorted(maps.Keys(keys))
}

func readChatError(c *client) chatErrorMsg {
	c.t.Helper()
	env := nextChat(c)
	if env.T != typeChatError {
		c.t.Fatalf("got %s %s, want chatError", env.T, env.D)
	}
	return decode[chatErrorMsg](c.t, env)
}

var (
	chatKeys   = []string{"at", "from", "fromName", "id", "scope", "text"}
	echoKeys   = []string{"at", "cid", "from", "fromName", "id", "scope", "text"}
	directKeys = []string{"at", "from", "fromName", "id", "scope", "text", "to"}
)

func TestChatScopes(t *testing.T) {
	url := serveLine(t, slog.New(slog.DiscardHandler))
	ana, bob, carol := joinLine(t, url)

	before := time.Now().Truncate(time.Millisecond)
	ana.chat("e1", chat.Everyone, "", "  <b>oi</b>\u202e & tchau \n")
	echo, keys := readChat(ana)
	if at := time.UnixMilli(echo.At); echo.ID == "" || at.Before(before) || at.After(time.Now()) {
		t.Errorf("echo id %q at %v, want an id and the server time", echo.ID, at)
	}
	want := chatOut{
		ID: echo.ID, At: echo.At, From: "guest:ana", FromName: "Ana",
		Scope: chat.Everyone, Text: "<b>oi</b> & tchau", CID: "e1",
	}
	if echo != want || !slices.Equal(keys, echoKeys) {
		t.Errorf("echo = %+v %v, want %+v %v", echo, keys, want, echoKeys)
	}
	want.CID = ""
	for _, c := range []*client{bob, carol} {
		if got, keys := readChat(c); got != want || !slices.Equal(keys, chatKeys) {
			t.Errorf("received %+v %v, want %+v %v", got, keys, want, chatKeys)
		}
	}

	ana.chat("n1", chat.Nearby, "", "perto")
	if got, _ := readChat(ana); got.CID != "n1" || got.Scope != chat.Nearby || got.Text != "perto" {
		t.Errorf("nearby echo = %+v", got)
	}
	if got, keys := readChat(bob); got.Scope != chat.Nearby || got.Text != "perto" || !slices.Equal(keys, chatKeys) {
		t.Errorf("bob received %+v %v, want the nearby chat", got, keys)
	}
	// Chats from one sender arrive in order, so a later everyone chat shows
	// Carol never got the nearby one.
	ana.chat("e2", chat.Everyone, "", "marco")
	readChat(ana)
	if got, _ := readChat(carol); got.Text != "marco" {
		t.Errorf("carol received %+v, want only the everyone chat", got)
	}
	readChat(bob)

	carol.chat("n2", chat.Nearby, "", "sozinha")
	if got, _ := readChat(carol); got.CID != "n2" {
		t.Errorf("echo with nobody near = %+v", got)
	}
	carol.chat("e3", chat.Everyone, "", "marco carol")
	readChat(carol)
	for _, c := range []*client{ana, bob} {
		if got, _ := readChat(c); got.Text != "marco carol" {
			t.Errorf("received %+v, want only the everyone chat", got)
		}
	}

	ana.chat("d1", chat.Direct, "guest:carol", "só pra você")
	if got, keys := readChat(ana); got.CID != "d1" || got.To != "guest:carol" || !slices.Contains(keys, "to") {
		t.Errorf("direct echo = %+v %v", got, keys)
	}
	if got, keys := readChat(carol); got.To != "guest:carol" || got.From != "guest:ana" || got.Text != "só pra você" || !slices.Equal(keys, directKeys) {
		t.Errorf("carol received %+v %v, want the direct chat", got, keys)
	}
	ana.chat("e4", chat.Everyone, "", "marco 2")
	readChat(ana)
	readChat(carol)
	if got, _ := readChat(bob); got.Text != "marco 2" {
		t.Errorf("bob received %+v, want only the everyone chat", got)
	}

	bob.chat("d2", chat.Direct, "guest:zed", "alô")
	if got := readChatError(bob); got != (chatErrorMsg{CID: "d2", Reason: chatOffline}) {
		t.Errorf("direct to nobody = %+v, want offline", got)
	}
	carol.conn.Close(websocket.StatusNormalClosure, "")
	expect(bob, typeLeft, func(l leftMsg) bool { return l.ID == "guest:carol" })
	bob.chat("d3", chat.Direct, "guest:carol", "alô")
	if got := readChatError(bob); got != (chatErrorMsg{CID: "d3", Reason: chatOffline}) {
		t.Errorf("direct to who left = %+v, want offline", got)
	}
}

func TestChatRejected(t *testing.T) {
	url := serveLine(t, slog.New(slog.DiscardHandler))
	ana := dial(t, url, "Ana")
	expect[welcomeMsg](ana, typeWelcome, nil)

	raw := func(cid, fields string) string {
		return `{"t":"chat","d":{"cid":"` + cid + `",` + fields + `}}`
	}
	long := raw("t1", `"scope":"everyone","text":"`+strings.Repeat("\U0001d54f", 2000)+`"`)
	if len(long) <= 4<<10 || len(long) > maxMessageSize {
		t.Fatalf("2000 four-byte runes take %d bytes, want between 4 and 8 KiB", len(long))
	}
	tests := []struct {
		name   string
		msg    string
		reason string
	}{
		{"unknown scope", raw("i1", `"scope":"all","text":"x"`), chatInvalid},
		{"no scope", raw("i2", `"text":"x"`), chatInvalid},
		{"direct without to", raw("i3", `"scope":"direct","text":"x"`), chatInvalid},
		{"direct to empty", raw("i4", `"scope":"direct","to":"","text":"x"`), chatInvalid},
		{"to outside direct", raw("i5", `"scope":"everyone","to":"guest:bob","text":"x"`), chatInvalid},
		{"empty to outside direct", raw("i6", `"scope":"nearby","to":"","text":"x"`), chatInvalid},
		{"direct to self", raw("i7", `"scope":"direct","to":"guest:ana","text":"x"`), chatInvalid},
		{"to too long", raw("i8", `"scope":"direct","to":"`+strings.Repeat("x", maxToLen+1)+`","text":"x"`), chatInvalid},
		{"empty", raw("m1", `"scope":"everyone","text":" \u202e\u200b \n "`), chatEmpty},
		{"no text", raw("m2", `"scope":"everyone"`), chatEmpty},
		{"2000 four-byte runes", long, chatTooLong},
		{"21 lines", raw("t2", `"scope":"everyone","text":"`+strings.Repeat(`a\n`, chat.MaxLines)+`a"`), chatTooLong},
		{"direct to 300 bytes", raw("o1", `"scope":"direct","to":"`+strings.Repeat("x", maxToLen)+`","text":"x"`), chatOffline},
	}
	for _, tt := range tests {
		ana.sendRaw(tt.msg)
		got := readChatError(ana)
		var d chatIn
		if err := json.Unmarshal([]byte(tt.msg[len(`{"t":"chat","d":`):len(tt.msg)-1]), &d); err != nil {
			t.Fatal(err)
		}
		if got != (chatErrorMsg{CID: d.CID, Reason: tt.reason}) {
			t.Errorf("%s: got %+v, want %s", tt.name, got, tt.reason)
		}
	}

	ana.send(typePing, pingMsg{TS: 1})
	expect[pingMsg](ana, typePong, nil)
}

func TestChatRateLimit(t *testing.T) {
	url := serveLine(t, slog.New(slog.DiscardHandler))
	ana := dial(t, url, "Ana")
	expect[welcomeMsg](ana, typeWelcome, nil)

	want := map[string]string{
		"i1": chatInvalid, "m1": chatEmpty, "t1": chatTooLong,
		"c1": "", "c2": "", "c3": "", "c4": "", "c5": "",
		"c6": chatRateLimited, "c7": chatRateLimited,
		"i2": chatInvalid,
	}
	ana.chat("i1", "all", "", "x")
	ana.chat("m1", chat.Everyone, "", "\u200b")
	ana.chat("t1", chat.Everyone, "", strings.Repeat("x", chat.MaxRunes+1))
	for i := 1; i <= 7; i++ {
		ana.chat("c"+strconv.Itoa(i), chat.Everyone, "", "flood")
	}
	ana.chat("i2", chat.Everyone, "guest:bob", "x")
	ana.send(typePing, pingMsg{TS: 1})

	// Echoes come from the room and errors from the session, so only the
	// set is fixed, not the order.
	got := make(map[string]string)
	pong := false
	for len(got) < len(want) || !pong {
		env, err := ana.read()
		if err != nil {
			t.Fatalf("connection dropped: %v (answers so far %v)", err, got)
		}
		switch env.T {
		case typeChat:
			got[decode[chatOut](t, env).CID] = ""
		case typeChatError:
			e := decode[chatErrorMsg](t, env)
			got[e.CID] = e.Reason
		case typePong:
			pong = true
		}
	}
	if !maps.Equal(got, want) {
		t.Errorf("answers = %v, want %v", got, want)
	}

	time.Sleep(time.Duration(float64(time.Second)/chatRate) + 100*time.Millisecond)
	ana.chat("c8", chat.Everyone, "", "de novo")
	if got, _ := readChat(ana); got.CID != "c8" {
		t.Errorf("after refill got %+v, want the echo", got)
	}
}

func TestChatPolicyViolations(t *testing.T) {
	url := serveLine(t, slog.New(slog.DiscardHandler))
	tests := []struct {
		name string
		d    string
	}{
		{"no cid", `{"scope":"everyone","text":"x"}`},
		{"empty cid", `{"cid":"","scope":"everyone","text":"x"}`},
		{"cid too long", `{"cid":"` + strings.Repeat("a", maxCIDLen+1) + `","scope":"everyone","text":"x"}`},
		{"cid with space", `{"cid":"a b","scope":"everyone","text":"x"}`},
		{"cid not ascii", `{"cid":"çid","scope":"everyone","text":"x"}`},
		{"cid number", `{"cid":1,"scope":"everyone","text":"x"}`},
		{"text number", `{"cid":"a","scope":"everyone","text":1}`},
		{"scope number", `{"cid":"a","scope":1,"text":"x"}`},
		{"to number", `{"cid":"a","scope":"direct","to":1,"text":"x"}`},
		{"not an object", `"x"`},
		{"null", `null`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			c := dial(t, url, "Dora")
			expect[welcomeMsg](c, typeWelcome, nil)
			c.sendRaw(`{"t":"chat","d":` + tt.d + `}`)
			c.expectClose(websocket.StatusPolicyViolation)
		})
	}
}

func TestDecodeChat(t *testing.T) {
	to := "guest:bob"
	tests := []struct {
		msg  string
		want chatIn
	}{
		{`{"t":"chat","d":{"cid":"A-z_09","scope":"direct","to":"guest:bob","text":"oi"}}`,
			chatIn{CID: "A-z_09", Scope: chat.Direct, To: &to, Text: "oi"}},
		{`{"t":"chat","d":{"cid":"` + strings.Repeat("x", maxCIDLen) + `","scope":"everyone","to":null,"text":"oi"}}`,
			chatIn{CID: strings.Repeat("x", maxCIDLen), Scope: chat.Everyone, Text: "oi"}},
		{`{"t":"chat","d":{"cid":"x","scope":"all"}}`, chatIn{CID: "x", Scope: "all"}},
	}
	for _, tt := range tests {
		msg, err := decodeClient([]byte(tt.msg))
		if err != nil {
			t.Errorf("%s: %v", tt.msg, err)
			continue
		}
		got, ok := msg.(chatIn)
		if !ok || got.CID != tt.want.CID || got.Scope != tt.want.Scope || got.Text != tt.want.Text ||
			(got.To == nil) != (tt.want.To == nil) || got.To != nil && *got.To != *tt.want.To {
			t.Errorf("%s: decoded %#v, want %#v", tt.msg, msg, tt.want)
		}
	}
	for _, msg := range []string{
		`{"t":"chat","d":{"cid":"` + strings.Repeat("x", maxCIDLen+1) + `"}}`,
		`{"t":"chat","d":{"cid":"x/y"}}`,
		`{"t":"chat","d":{"cid":"x","text":"segredo \q"}}`,
	} {
		_, err := decodeClient([]byte(msg))
		if !errors.Is(err, errInvalidMessage) {
			t.Errorf("%s: err = %v, want %v", msg, err, errInvalidMessage)
		}
		if err != nil && strings.Contains(err.Error(), "segredo") {
			t.Errorf("error %q quotes the message", err)
		}
	}
}

func TestChatInValid(t *testing.T) {
	str := func(s string) *string { return &s }
	tests := []struct {
		name string
		m    chatIn
		want bool
	}{
		{"everyone", chatIn{Scope: chat.Everyone}, true},
		{"nearby", chatIn{Scope: chat.Nearby}, true},
		{"direct", chatIn{Scope: chat.Direct, To: str("guest:bob")}, true},
		{"direct to 300 bytes", chatIn{Scope: chat.Direct, To: str(strings.Repeat("x", maxToLen))}, true},
		{"unknown scope", chatIn{Scope: "all"}, false},
		{"no scope", chatIn{}, false},
		{"direct without to", chatIn{Scope: chat.Direct}, false},
		{"direct to empty", chatIn{Scope: chat.Direct, To: str("")}, false},
		{"direct to 301 bytes", chatIn{Scope: chat.Direct, To: str(strings.Repeat("x", maxToLen+1))}, false},
		{"direct to self", chatIn{Scope: chat.Direct, To: str("guest:ana")}, false},
		{"to outside direct", chatIn{Scope: chat.Everyone, To: str("guest:bob")}, false},
		{"empty to outside direct", chatIn{Scope: chat.Nearby, To: str("")}, false},
	}
	for _, tt := range tests {
		if got := tt.m.valid("guest:ana"); got != tt.want {
			t.Errorf("%s: valid = %v, want %v", tt.name, got, tt.want)
		}
	}
}

// runLineRoom runs a room on testdata/line.tmj inside a synctest bubble.
func runLineRoom(t *testing.T, mi Media) *Room {
	t.Helper()
	m, err := tilemap.LoadFile("testdata/line.tmj")
	if err != nil {
		t.Fatal(err)
	}
	room := NewRoom(DefaultSpace, "line", world.NewSpace(m), mi, slog.New(slog.DiscardHandler))
	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan error)
	go func() { done <- room.Run(ctx) }()
	t.Cleanup(func() {
		cancel()
		if err := <-done; err != nil {
			t.Errorf("run: %v", err)
		}
	})
	return room
}

func TestChatJoinOrder(t *testing.T) {
	tests := []struct {
		name  string
		media func() Media
		want  []string
	}{
		{"without media", func() Media { return nil }, []string{typeWelcome, typeNearby, typeChatHistory}},
		{"with media", func() Media { return &fakeIssuer{ttl: time.Hour} }, []string{typeWelcome, typeMedia, typeNearby, typeChatHistory}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				room := runLineRoom(t, tt.media())
				ana := joinAs(t, room, "Ana")
				synctest.Wait()
				if got := drain(t, ana); !slices.Equal(got, tt.want) {
					t.Errorf("first join = %v, want %v", got, tt.want)
				}
				bob := joinAs(t, room, "Bob")
				synctest.Wait()
				if got := drain(t, bob); !slices.Equal(got, tt.want) {
					t.Errorf("second join = %v, want %v", got, tt.want)
				}
				if got := drain(t, ana); !slices.Equal(got, []string{typeJoined}) {
					t.Errorf("others got %v, want joined after the newcomer's messages", got)
				}
			})
		})
	}
}

func TestChatHistory(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		room := runLineRoom(t, nil)
		ana := joinAs(t, room, "Ana")
		carol := joinAs(t, room, "Carol")
		send := func(scope chat.Scope, to, text string) {
			t.Helper()
			if err := room.chat(t.Context(), sessionChat{sess: ana, cid: "c", scope: scope, to: to, text: text}); err != nil {
				t.Fatal(err)
			}
			// Stays within the room's everyone limit.
			time.Sleep(time.Second / everyoneRate)
			synctest.Wait()
			drain(t, ana)
			drain(t, carol)
		}
		send(chat.Direct, "guest:carol", "direct")
		send(chat.Nearby, "", "nearby")
		for i := range chat.HistorySize + 5 {
			send(chat.Everyone, "", strconv.Itoa(i))
		}

		history := func(name string) []chatOut {
			t.Helper()
			s := joinAs(t, room, name)
			synctest.Wait()
			var envs []envelope
			for len(s.out) > 0 {
				envs = append(envs, received(t, s))
			}
			if len(envs) != 3 || envs[2].T != typeChatHistory {
				t.Fatalf("join got %d messages, want chatHistory third", len(envs))
			}
			return decode[chatHistoryMsg](t, envs[2]).Messages
		}
		ms := history("Bob")
		if len(ms) != chat.HistorySize {
			t.Fatalf("history has %d messages, want %d", len(ms), chat.HistorySize)
		}
		ids := make(map[string]bool)
		for i, m := range ms {
			want := chatOut{ID: m.ID, At: m.At, From: "guest:ana", FromName: "Ana", Scope: chat.Everyone, Text: strconv.Itoa(i + 5)}
			if m != want || ids[m.ID] {
				t.Fatalf("history[%d] = %+v, want %+v with a unique id", i, m, want)
			}
			ids[m.ID] = true
		}

		send(chat.Everyone, "", "last")
		ms = history("Dora")
		if len(ms) != chat.HistorySize || ms[0].Text != "6" || ms[len(ms)-1].Text != "last" {
			t.Errorf("history after one more = %d messages from %q to %q", len(ms), ms[0].Text, ms[len(ms)-1].Text)
		}
	})
}

type syncBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuffer) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

// TestChatLogsNoContent marks every text, recipient and cid with "segredo"
// and goes through every path a chat takes, including the closes.
func TestChatLogsNoContent(t *testing.T) {
	var buf syncBuffer
	// Registered first, so it runs after the server stopped.
	t.Cleanup(func() {
		logs := buf.String()
		if strings.Contains(strings.ToLower(logs), "segredo") {
			t.Errorf("logs carry chat content:\n%s", logs)
		}
		for _, reason := range []string{chatInvalid, chatEmpty, chatTooLong, chatRateLimited, chatOffline} {
			if !strings.Contains(logs, `level=DEBUG msg="chat rejected"`) || !strings.Contains(logs, "reason="+reason) {
				t.Errorf("no chat rejected log with reason %s:\n%s", reason, logs)
			}
		}
	})
	url := serveLine(t, slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug})))
	ana, bob, carol := joinLine(t, url)
	rejected := func(c *client) {
		t.Helper()
		for nextChat(c).T != typeChatError {
		}
	}

	ana.chat("segredo1", chat.Everyone, "", "segredo everyone")
	readChat(ana)
	ana.chat("segredo2", chat.Nearby, "", "segredo nearby")
	readChat(ana)
	ana.chat("segredo3", chat.Direct, "guest:carol", "segredo direct")
	readChat(ana)
	bob.chat("segredo4", chat.Direct, "guest:segredo", "segredo offline")
	rejected(bob)
	bob.chat("segredo5", chat.Everyone, "guest:segredo", "segredo invalid")
	rejected(bob)
	bob.chat("segredo6", "segredo", "", "segredo scope")
	rejected(bob)
	bob.chat("segredo7", chat.Everyone, "", "\u200b")
	rejected(bob)
	bob.chat("segredo8", chat.Everyone, "", strings.Repeat("segredo ", 100))
	rejected(bob)
	for i := range chatBurst + 1 {
		carol.chat("segredo"+strconv.Itoa(10+i), chat.Everyone, "", "segredo flood")
	}
	rejected(carol)

	for _, msg := range []string{
		`{"t":"chat","d":{"cid":"segredo cid","scope":"everyone","text":"segredo"}}`,
		`{"t":"chat","d":{"cid":"x","scope":"everyone","text":"segredo \q"}}`,
		`{"t":"chat","d":{"cid":"x","scope":"everyone","text":["segredo"]}}`,
		`{"t":"chat","d":{"cid":"x","scope":"everyone","text":"segredo"`,
	} {
		c := dial(t, url, "Dora")
		expect[welcomeMsg](c, typeWelcome, nil)
		c.sendRaw(msg)
		c.expectClose(websocket.StatusPolicyViolation)
	}
}

// BenchmarkChatEveryone200 routes one everyone chat in a room of 200,
// from the room goroutine's handling to every send queued.
func BenchmarkChatEveryone200(b *testing.B) {
	m, err := tilemap.LoadFile("testdata/line.tmj")
	if err != nil {
		b.Fatal(err)
	}
	log := slog.New(slog.DiscardHandler)
	room := NewRoom(DefaultSpace, "line", world.NewSpace(m), nil, log)
	sessions := make([]*Session, 200)
	drainAll := func() {
		for _, s := range sessions {
			for s != nil && len(s.out) > 0 {
				<-s.out
			}
		}
	}
	for i := range sessions {
		sessions[i] = newSession(auth.Identity{ID: "guest:bot-" + strconv.Itoa(i), Name: "bot " + strconv.Itoa(i)}, nil, room, nil, log)
		room.handleJoin(sessions[i])
		drainAll()
	}
	c := sessionChat{sess: sessions[0], cid: "c1", scope: chat.Everyone, text: strings.Repeat("olá, pessoal ", 10)}
	// Measures routing, not the room's everyone limit.
	room.everyone = newTokenBucket(everyoneRate, 1<<40)

	b.ReportAllocs()
	for b.Loop() {
		room.handleChat(c)
		drainAll()
	}
	for _, s := range sessions {
		select {
		case <-s.done:
			b.Fatalf("%s closed: %+v", s.id, s.closeWith)
		default:
		}
	}
}

func TestChatRateLimitSurvivesReconnect(t *testing.T) {
	url := serveLine(t, slog.New(slog.DiscardHandler))
	ana := dial(t, url, "Ana")
	expect[welcomeMsg](ana, typeWelcome, nil)
	for i := range chatBurst {
		ana.chat("c"+strconv.Itoa(i), chat.Everyone, "", "oi")
		readChat(ana)
	}
	ana.conn.Close(websocket.StatusNormalClosure, "")

	again := dial(t, url, "Ana")
	expect[welcomeMsg](again, typeWelcome, nil)
	again.chat("r1", chat.Everyone, "", "de volta")
	if got := readChatError(again); got != (chatErrorMsg{CID: "r1", Reason: chatRateLimited}) {
		t.Errorf("after reconnecting got %+v, want rate_limited", got)
	}
	bob := dial(t, url, "Bob")
	expect[welcomeMsg](bob, typeWelcome, nil)
	bob.chat("b1", chat.Everyone, "", "oi")
	if got, _ := readChat(bob); got.CID != "b1" {
		t.Errorf("another identity got %+v, want the echo", got)
	}
}

func TestChatLimitsForgetRefilledBuckets(t *testing.T) {
	l := newChatLimits()
	t0 := time.Unix(1000, 0)
	drain := func(id string, now time.Time) {
		t.Helper()
		for range chatBurst {
			if !l.allow(id, now) {
				t.Fatalf("%s rejected within burst", id)
			}
		}
		if l.allow(id, now) {
			t.Fatalf("%s allowed past the burst", id)
		}
	}
	drain("a", t0)
	drain("b", t0.Add(chatSweep-time.Second))
	if len(l.buckets) != 2 {
		t.Fatalf("%d buckets before the sweep, want 2", len(l.buckets))
	}

	now := t0.Add(chatSweep)
	if !l.allow("c", now) {
		t.Fatal("new identity rejected")
	}
	if _, ok := l.buckets["a"]; ok {
		t.Error("refilled bucket a kept after the sweep")
	}
	if _, ok := l.buckets["b"]; !ok {
		t.Error("bucket b dropped while still refilling")
	}
	if l.allow("b", now) {
		t.Error("b allowed with half a token")
	}
	if !l.allow("a", now) {
		t.Error("a rejected after refilling")
	}
}

func TestChatEveryoneRoomLimit(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		room := runLineRoom(t, nil)
		ana := joinAs(t, room, "Ana")
		bob := joinAs(t, room, "Bob")
		synctest.Wait()
		drain(t, ana)
		drain(t, bob)

		send := func(cid string, scope chat.Scope, to string) {
			t.Helper()
			if err := room.chat(t.Context(), sessionChat{sess: ana, cid: cid, scope: scope, to: to, text: "x"}); err != nil {
				t.Fatal(err)
			}
		}
		for i := range everyoneBurst + 1 {
			send("e"+strconv.Itoa(i), chat.Everyone, "")
		}
		send("d1", chat.Direct, "guest:bob")
		synctest.Wait()

		var echoes int
		var errs []chatErrorMsg
		for len(ana.out) > 0 {
			switch env := received(t, ana); env.T {
			case typeChat:
				echoes++
			case typeChatError:
				errs = append(errs, decode[chatErrorMsg](t, env))
			}
		}
		if echoes != everyoneBurst+1 || len(errs) != 1 || errs[0] != (chatErrorMsg{CID: "e" + strconv.Itoa(everyoneBurst), Reason: chatRateLimited}) {
			t.Errorf("sender got %d echoes and errors %v, want %d echoes and the last everyone rate_limited", echoes, errs, everyoneBurst+1)
		}
		if got := len(drain(t, bob)); got != everyoneBurst+1 {
			t.Errorf("bob got %d chats, want %d everyone and the direct one", got, everyoneBurst)
		}

		time.Sleep(time.Second / everyoneRate)
		send("e-late", chat.Everyone, "")
		synctest.Wait()
		if got := drain(t, bob); !slices.Contains(got, typeChat) {
			t.Errorf("after refill bob got %v, want a chat", got)
		}
	})
}

// TestEveryoneFloodKeepsReaders has 100 members each fire two everyone
// chats at once at a reader that drains nothing meanwhile: the room limit
// and the send buffer together must keep the reader connected.
func TestEveryoneFloodKeepsReaders(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		room := runLineRoom(t, nil)
		reader := joinAs(t, room, "Reader")
		senders := make([]*Session, 100)
		for i := range senders {
			senders[i] = joinAs(t, room, "s"+strconv.Itoa(i))
		}
		synctest.Wait()
		for _, s := range senders {
			drain(t, s)
		}
		for i := range 2 {
			for _, s := range senders {
				if err := room.chat(t.Context(), sessionChat{sess: s, cid: "c" + strconv.Itoa(i), scope: chat.Everyone, text: strings.Repeat("x", 400)}); err != nil {
					t.Fatal(err)
				}
			}
		}
		synctest.Wait()
		select {
		case <-reader.done:
			t.Fatalf("reader closed: %+v", reader.closeWith)
		default:
		}
		chats := 0
		for _, typ := range drain(t, reader) {
			if typ == typeChat {
				chats++
			}
		}
		if chats != everyoneBurst {
			t.Errorf("reader got %d chats, want the room's burst of %d", chats, everyoneBurst)
		}
	})
}
