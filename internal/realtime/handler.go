package realtime

import (
	"errors"
	"log/slog"
	"net/http"

	"github.com/coder/websocket"

	"github.com/victoroliveirabarros/vb-office-32/internal/auth"
)

// DefaultSpace is the only space in phase 1.
const DefaultSpace = "office"

type Authenticator interface {
	Authenticate(r *http.Request) (auth.Identity, error)
}

type Handler struct {
	hub            *Hub
	auth           Authenticator
	originPatterns []string
	slots          chan struct{}
	chats          *chatLimits
	log            *slog.Logger
}

// NewHandler accepts at most maxSessions concurrent connections; the limit
// counts connections, not identities.
func NewHandler(hub *Hub, authn Authenticator, originPatterns []string, maxSessions int, log *slog.Logger) *Handler {
	return &Handler{
		hub:            hub,
		auth:           authn,
		originPatterns: originPatterns,
		slots:          make(chan struct{}, maxSessions),
		chats:          newChatLimits(),
		log:            log,
	}
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	id, err := h.auth.Authenticate(r)
	if err != nil {
		if errors.Is(err, auth.ErrInvalidName) {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		http.Error(w, http.StatusText(http.StatusUnauthorized), http.StatusUnauthorized)
		return
	}
	room, ok := h.hub.Room(DefaultSpace)
	if !ok {
		http.Error(w, "space not found", http.StatusNotFound)
		return
	}
	select {
	case h.slots <- struct{}{}:
	default:
		h.log.Warn("server full", "max", cap(h.slots))
		http.Error(w, "server full", http.StatusServiceUnavailable)
		return
	}
	defer func() { <-h.slots }()

	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{OriginPatterns: h.originPatterns})
	if err != nil {
		h.log.Debug("websocket accept", "err", err)
		return
	}
	// The session enforces maxMessageSize itself to close with 1008; the
	// library limit would close with 1009.
	conn.SetReadLimit(-1)

	s := newSession(id, conn, room, h.chats, h.log.With("session", id.ID))
	if err := room.join(r.Context(), s); err != nil {
		conn.Close(websocket.StatusGoingAway, reasonRestarting)
		return
	}
	s.run(r.Context())
	room.leave(s)
}
