package realtime

import (
	"encoding/json"
	"errors"
	"fmt"
	"strconv"

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
)

var errInvalidMessage = errors.New("invalid message")

type envelope struct {
	T string          `json:"t"`
	D json.RawMessage `json:"d"`
}

// clientMsg is a decoded client message: moveMsg or pingMsg.
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

func (moveMsg) clientMsg() {}
func (pingMsg) clientMsg() {}

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

func newPlayerMsg(p world.Player) playerMsg {
	return playerMsg{ID: p.ID, Name: p.Name, X: p.Pos.X, Y: p.Pos.Y, Dir: p.Dir}
}

func decodeClient(b []byte) (clientMsg, error) {
	var env envelope
	if err := json.Unmarshal(b, &env); err != nil {
		return nil, fmt.Errorf("%w: %w", errInvalidMessage, err)
	}
	switch env.T {
	case typeMove:
		var m moveMsg
		if err := json.Unmarshal(env.D, &m); err != nil {
			return nil, fmt.Errorf("%w: move: %w", errInvalidMessage, err)
		}
		if !m.Dir.Valid() {
			return nil, fmt.Errorf("%w: move: dir %q", errInvalidMessage, m.Dir)
		}
		return m, nil
	case typePing:
		var m pingMsg
		if err := json.Unmarshal(env.D, &m); err != nil {
			return nil, fmt.Errorf("%w: ping: %w", errInvalidMessage, err)
		}
		return m, nil
	}
	return nil, fmt.Errorf("%w: type %q", errInvalidMessage, env.T)
}

func encode(t string, d any) ([]byte, error) {
	b, err := json.Marshal(struct {
		T string `json:"t"`
		D any    `json:"d"`
	}{t, d})
	if err != nil {
		return nil, fmt.Errorf("encode %s: %w", t, err)
	}
	return b, nil
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
