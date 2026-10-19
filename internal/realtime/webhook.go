package realtime

import (
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/victoroliveirabarros/vb-office-32/internal/media"
)

// EventReader verifies and decodes the media server's webhooks.
type EventReader interface {
	ReadEvent(r *http.Request, now time.Time) (media.Event, error)
}

// NewWebhookHandler removes a participant from the media room as soon as
// the media server reports it active without a session here. The periodic
// reconciliation still catches whoever a lost webhook lets through.
func NewWebhookHandler(hub *Hub, events EventReader, log *slog.Logger) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ev, err := events.ReadEvent(r, time.Now())
		if err != nil {
			status := http.StatusBadRequest
			if errors.Is(err, media.ErrUnauthorized) {
				status = http.StatusUnauthorized
			}
			log.Warn("media webhook rejected", "status", status, "err", err)
			http.Error(w, http.StatusText(status), status)
			return
		}
		if room, ok := hub.Room(ev.Room); ok && ev.Event == "participant_joined" && ev.Identity != "" {
			if err := room.mediaArrived(r.Context(), ev.Identity); err != nil {
				http.Error(w, http.StatusText(http.StatusServiceUnavailable), http.StatusServiceUnavailable)
				return
			}
		}
		w.WriteHeader(http.StatusOK)
	})
}
