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
	log            *slog.Logger
}

func NewHandler(hub *Hub, authn Authenticator, originPatterns []string, log *slog.Logger) *Handler {
	return &Handler{hub: hub, auth: authn, originPatterns: originPatterns, log: log}
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	id, err := h.auth.Authenticate(r)
	if err != nil {
		status := http.StatusUnauthorized
		if errors.Is(err, auth.ErrInvalidName) {
			status = http.StatusBadRequest
		}
		http.Error(w, err.Error(), status)
		return
	}
	room, ok := h.hub.Room(DefaultSpace)
	if !ok {
		http.Error(w, "space not found", http.StatusNotFound)
		return
	}

	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{OriginPatterns: h.originPatterns})
	if err != nil {
		h.log.Debug("websocket accept", "err", err)
		return
	}
	// The session enforces maxMessageSize itself to close with 1008; the
	// library limit would close with 1009.
	conn.SetReadLimit(-1)

	s := newSession(id.ID, id.Name, conn, room, h.log.With("session", id.ID))
	if err := room.join(r.Context(), s); err != nil {
		conn.Close(websocket.StatusGoingAway, "server shutting down")
		return
	}
	s.run(r.Context())
	room.leave(s)
}
