// Package realtime runs rooms and their WebSocket sessions.
package realtime

import (
	"context"

	"golang.org/x/sync/errgroup"
)

type Hub struct {
	rooms map[string]*Room
}

func NewHub(rooms ...*Room) *Hub {
	h := &Hub{rooms: make(map[string]*Room, len(rooms))}
	for _, r := range rooms {
		h.rooms[r.id] = r
	}
	return h
}

func (h *Hub) Room(id string) (*Room, bool) {
	r, ok := h.rooms[id]
	return r, ok
}

func (h *Hub) Run(ctx context.Context) error {
	g, ctx := errgroup.WithContext(ctx)
	for _, r := range h.rooms {
		g.Go(func() error { return r.Run(ctx) })
	}
	return g.Wait()
}
