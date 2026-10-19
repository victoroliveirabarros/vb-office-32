package realtime

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"

	"github.com/victoroliveirabarros/vb-office-32/internal/chat"
	"github.com/victoroliveirabarros/vb-office-32/internal/world"
)

const (
	typeMove    = "move"
	typePing    = "ping"
	typeWelcome = "welcome"
	typeJoined  = "joined"
	typeLeft    = "left"
	typeState   = "state"
	typePong    = "pong"
	typeMedia   = "media"
	typeNearby  = "nearby"

	typeChat        = "chat"
	typeChatHistory = "chatHistory"
	typeChatError   = "chatError"

	maxCIDLen = 36
	maxToLen  = 300

	chatRateLimited = "rate_limited"
	chatTooLong     = "too_long"
	chatEmpty       = "empty"
	chatOffline     = "offline"
	chatInvalid     = "invalid"
)

var errInvalidMessage = errors.New("invalid message")

type envelope struct {
	T string          `json:"t"`
	D json.RawMessage `json:"d"`
}

// clientMsg is a decoded client message: moveMsg, pingMsg or chatIn.
type clientMsg interface {
	clientMsg()
}

type moveMsg struct {
	Seq uint32    `json:"seq"`
	Dir world.Dir `json:"dir"`
}

type pingMsg struct {
	TS float64 `json:"ts"`
}

// chatIn is a chat as the client sends it; To is nil when absent.
type chatIn struct {
	CID   string     `json:"cid"`
	Scope chat.Scope `json:"scope"`
	To    *string    `json:"to"`
	Text  string     `json:"text"`
}

func (moveMsg) clientMsg() {}
func (pingMsg) clientMsg() {}
func (chatIn) clientMsg()  {}

// valid checks what a well-formed chat can still get wrong; the answer is a
// chatError, not a close.
func (m chatIn) valid(self string) bool {
	switch {
	case !m.Scope.Valid():
		return false
	case m.Scope != chat.Direct:
		return m.To == nil
	}
	return m.To != nil && *m.To != "" && len(*m.To) <= maxToLen && *m.To != self
}

func validCID(cid string) bool {
	if cid == "" || len(cid) > maxCIDLen {
		return false
	}
	for _, c := range []byte(cid) {
		switch {
		case 'a' <= c && c <= 'z', 'A' <= c && c <= 'Z', '0' <= c && c <= '9', c == '_', c == '-':
		default:
			return false
		}
	}
	return true
}

type playerMsg struct {
	ID   string    `json:"id"`
	Name string    `json:"name"`
	X    int       `json:"x"`
	Y    int       `json:"y"`
	Dir  world.Dir `json:"dir"`
}

type posMsg struct {
	ID  string    `json:"id"`
	X   int       `json:"x"`
	Y   int       `json:"y"`
	Dir world.Dir `json:"dir"`
}

type welcomeMsg struct {
	SelfID   string      `json:"selfId"`
	MapID    string      `json:"mapId"`
	TickRate int         `json:"tickRate"`
	StepMs   int64       `json:"stepMs"`
	Players  []playerMsg `json:"players"`
}

type leftMsg struct {
	ID string `json:"id"`
}

// mediaMsg carries the LiveKit connection; ExpiresAt is unix milliseconds.
type mediaMsg struct {
	URL       string `json:"url"`
	Token     string `json:"token"`
	ExpiresAt int64  `json:"expiresAt"`
}

type nearbyMsg struct {
	IDs []string `json:"ids"`
}

// chatOut is a chat as clients receive it: At is unix milliseconds, To is
// set only for direct and CID only in the sender's echo.
type chatOut struct {
	ID       string     `json:"id"`
	At       int64      `json:"at"`
	From     string     `json:"from"`
	FromName string     `json:"fromName"`
	Scope    chat.Scope `json:"scope"`
	To       string     `json:"to,omitempty"`
	Text     string     `json:"text"`
	CID      string     `json:"cid,omitempty"`
}

type chatHistoryMsg struct {
	Messages []chatOut `json:"messages"`
}

type chatErrorMsg struct {
	CID    string `json:"cid"`
	Reason string `json:"reason"`
}

func newChatOut(m chat.Message, cid string) chatOut {
	return chatOut{
		ID:       m.ID,
		At:       m.At.UnixMilli(),
		From:     m.From,
		FromName: m.FromName,
		Scope:    m.Scope,
		To:       m.To,
		Text:     m.Text,
		CID:      cid,
	}
}

func newPlayerMsg(p world.Player) playerMsg {
	return playerMsg{ID: p.ID, Name: p.Name, X: p.Pos.X, Y: p.Pos.Y, Dir: p.Dir}
}

func decodeClient(b []byte) (clientMsg, error) {
	var env envelope
	if err := json.Unmarshal(b, &env); err != nil {
		return nil, fmt.Errorf("%w: %w", errInvalidMessage, jsonError(err))
	}
	switch env.T {
	case typeMove:
		var m moveMsg
		if err := json.Unmarshal(env.D, &m); err != nil {
			return nil, fmt.Errorf("%w: move: %w", errInvalidMessage, jsonError(err))
		}
		if !m.Dir.Valid() {
			return nil, fmt.Errorf("%w: move: dir %q", errInvalidMessage, m.Dir)
		}
		return m, nil
	case typePing:
		var m pingMsg
		if err := json.Unmarshal(env.D, &m); err != nil {
			return nil, fmt.Errorf("%w: ping: %w", errInvalidMessage, jsonError(err))
		}
		return m, nil
	case typeChat:
		var m chatIn
		if err := json.Unmarshal(env.D, &m); err != nil {
			return nil, fmt.Errorf("%w: chat: %w", errInvalidMessage, jsonError(err))
		}
		if !validCID(m.CID) {
			return nil, fmt.Errorf("%w: chat: cid", errInvalidMessage)
		}
		return m, nil
	}
	return nil, fmt.Errorf("%w: type %q", errInvalidMessage, env.T)
}

// jsonError keeps where decoding failed and drops what the error quotes
// from the input, which may be chat text.
func jsonError(err error) error {
	var se *json.SyntaxError
	if errors.As(err, &se) {
		return fmt.Errorf("syntax error at offset %d", se.Offset)
	}
	var te *json.UnmarshalTypeError
	if errors.As(err, &te) {
		return fmt.Errorf("field %q: want %v", te.Field, te.Type)
	}
	return errors.New("malformed")
}

// encode leaves <, > and & as they are: clients parse JSON and show text
// with textContent only, never as HTML, and escaping would make chat text up
// to six times larger.
func encode(t string, d any) ([]byte, error) {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	err := enc.Encode(struct {
		T string `json:"t"`
		D any    `json:"d"`
	}{t, d})
	if err != nil {
		return nil, fmt.Errorf("encode %s: %w", t, err)
	}
	return bytes.TrimSuffix(b.Bytes(), []byte("\n")), nil
}

// encodeState splices pre-encoded positions into a per-recipient envelope so
// the position list is marshaled once per tick regardless of audience size.
func encodeState(tick uint64, ack uint32, players []byte) []byte {
	b := make([]byte, 0, len(players)+64)
	b = append(b, `{"t":"state","d":{"tick":`...)
	b = strconv.AppendUint(b, tick, 10)
	b = append(b, `,"ack":`...)
	b = strconv.AppendUint(b, uint64(ack), 10)
	b = append(b, `,"players":`...)
	b = append(b, players...)
	b = append(b, "}}"...)
	return b
}
