package realtime

import (
	"context"
	"log/slog"
	"net/url"
	"os"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/victoroliveirabarros/vb-office-32/internal/auth"
	"github.com/victoroliveirabarros/vb-office-32/internal/media"
	"github.com/victoroliveirabarros/vb-office-32/internal/tilemap"
	"github.com/victoroliveirabarros/vb-office-32/internal/world"
)

// TestLiveKitReconcile joins a real LiveKit server with one of our tokens
// and no WebSocket: the next check removes it, and again when it comes back
// with the same token, while a member stays. E.g.
//
//	docker run --rm --network host livekit/livekit-server:v1.13 --dev --bind 127.0.0.1
//	VB_OFFICE32_LIVEKIT_TEST_URL=http://localhost:7880 go test -run LiveKit ./internal/realtime
func TestLiveKitReconcile(t *testing.T) {
	base := os.Getenv("VB_OFFICE32_LIVEKIT_TEST_URL")
	if base == "" {
		t.Skip("VB_OFFICE32_LIVEKIT_TEST_URL not set")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	wsURL := "ws" + strings.TrimPrefix(base, "http")
	mc := media.NewClient(wsURL, "devkey", "secret")
	id := "reconcile-test-" + strconv.FormatInt(time.Now().UnixNano(), 36)

	m, err := tilemap.LoadFile("testdata/small.tmj")
	if err != nil {
		t.Fatal(err)
	}
	log := slog.New(slog.NewTextHandler(t.Output(), nil))
	room := NewRoom(id, "small", world.NewSpace(m), mc, log)
	room.checkEvery = time.Second
	rctx, stop := context.WithCancel(ctx)
	done := make(chan error)
	go func() { done <- room.Run(rctx) }()
	defer func() {
		stop()
		<-done
	}()

	ana := newSession(auth.Identity{ID: "guest:ana", Name: "Ana"}, nil, room, sessionLimits{}, log)
	if err := room.join(ctx, ana); err != nil {
		t.Fatal(err)
	}
	defer room.leave(ana)
	anaRTC := rtcJoin(t, ctx, mc, wsURL, "guest:ana", id)

	g, err := mc.Issue("guest:mallory", "Mallory", id, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	for i := range 2 {
		start := time.Now()
		closed := rtcDial(t, ctx, wsURL, g.Token)
		select {
		case <-closed:
			t.Logf("join %d removed after %v", i+1, time.Since(start).Round(time.Millisecond))
		case <-ctx.Done():
			t.Fatalf("join %d not removed", i+1)
		}
	}

	select {
	case <-anaRTC:
		t.Error("the member was removed")
	default:
	}
	ids, err := mc.Participants(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(ids, []string{"guest:ana"}) {
		t.Errorf("participants = %q, want only the member", ids)
	}
}

func rtcJoin(t *testing.T, ctx context.Context, mc *media.Client, wsURL, identity, room string) <-chan struct{} {
	t.Helper()
	g, err := mc.Issue(identity, identity, room, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	return rtcDial(t, ctx, wsURL, g.Token)
}

// rtcDial opens a LiveKit signal connection and returns a channel closed
// when the server ends it.
func rtcDial(t *testing.T, ctx context.Context, wsURL, token string) <-chan struct{} {
	t.Helper()
	conn, _, err := websocket.Dial(ctx, wsURL+"/rtc?protocol=16&access_token="+url.QueryEscape(token), nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.CloseNow() })
	conn.SetReadLimit(-1)
	closed := make(chan struct{})
	go func() {
		defer close(closed)
		for {
			if _, _, err := conn.Read(ctx); err != nil {
				return
			}
		}
	}()
	return closed
}
