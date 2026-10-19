package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/victoroliveirabarros/vb-office-32/internal/auth"
	"github.com/victoroliveirabarros/vb-office-32/internal/chat"
	"github.com/victoroliveirabarros/vb-office-32/internal/realtime"
	"github.com/victoroliveirabarros/vb-office-32/internal/tilemap"
	"github.com/victoroliveirabarros/vb-office-32/internal/world"
)

func serve(t *testing.T) string {
	t.Helper()
	m, err := tilemap.LoadFile("../../maps/office.tmj")
	if err != nil {
		t.Fatal(err)
	}
	log := slog.New(slog.DiscardHandler)
	hub := realtime.NewHub(realtime.NewRoom(realtime.DefaultSpace, "office", world.NewSpace(m), nil, log))
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- hub.Run(ctx) }()
	srv := httptest.NewServer(realtime.NewHandler(hub, auth.Guest{}, nil, 20, log))
	t.Cleanup(func() {
		cancel()
		if err := <-done; err != nil {
			t.Errorf("hub: %v", err)
		}
		srv.Close()
	})
	return "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws"
}

// fillHistory sends chats of 500 four-byte runes until the history passes
// 32 KiB, the library's default read limit.
func fillHistory(t *testing.T, url string) {
	t.Helper()
	ctx := t.Context()
	text := strings.Repeat("\U0001d54f", chat.MaxRunes)
	for w := range 4 {
		conn, _, err := websocket.Dial(ctx, fmt.Sprintf("%s?name=writer-%d", url, w), nil)
		if err != nil {
			t.Fatal(err)
		}
		conn.SetReadLimit(readLimit)
		for i := range 5 {
			cid := fmt.Sprint(i)
			msg, err := json.Marshal(map[string]any{"t": "chat", "d": map[string]string{"cid": cid, "scope": "everyone", "text": text}})
			if err != nil {
				t.Fatal(err)
			}
			if err := conn.Write(ctx, websocket.MessageText, msg); err != nil {
				t.Fatal(err)
			}
			for {
				_, b, err := conn.Read(ctx)
				if err != nil {
					t.Fatal(err)
				}
				var env struct {
					T string `json:"t"`
					D struct {
						CID string `json:"cid"`
					} `json:"d"`
				}
				if err := json.Unmarshal(b, &env); err != nil {
					t.Fatal(err)
				}
				if env.T == "chatError" {
					t.Fatalf("chat refused: %s", b)
				}
				if env.T == "chat" && env.D.CID == cid {
					break
				}
			}
		}
		conn.Close(websocket.StatusNormalClosure, "")
	}
}

func TestRunReadsLargeHistory(t *testing.T) {
	url := serve(t)
	fillHistory(t, url)

	var out bytes.Buffer
	cfg := config{url: url, n: 2, duration: 500 * time.Millisecond, step: 100 * time.Millisecond, chatEvery: time.Hour}
	if err := run(t.Context(), cfg, &out); err != nil {
		t.Fatalf("run: %v\n%s", err, out.String())
	}
	if !strings.Contains(out.String(), "bots:     2 connected, 0 failed") {
		t.Errorf("output:\n%s", out.String())
	}
}

func TestRunWithAppearance(t *testing.T) {
	url := serve(t)
	var out bytes.Buffer
	cfg := config{url: url, n: 3, duration: 300 * time.Millisecond, step: 100 * time.Millisecond, chatEvery: time.Hour, av: true}
	if err := run(t.Context(), cfg, &out); err != nil {
		t.Fatalf("run: %v\n%s", err, out.String())
	}
	if !strings.Contains(out.String(), "bots:     3 connected, 0 failed") {
		t.Errorf("output:\n%s", out.String())
	}
}

func TestRandomLookIsValid(t *testing.T) {
	for range 100 {
		if a := randomLook(); !a.Valid() {
			t.Fatalf("random look %v outside the catalog", a)
		}
	}
}
