// Command loadbot connects random-walking bots to a vb-office-32 server and
// reports ack latency.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"math/rand/v2"
	"os"
	"os/signal"
	"slices"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/coder/websocket"
)

var dirs = [...]string{"up", "down", "left", "right"}

type config struct {
	url      string
	n        int
	duration time.Duration
	step     time.Duration
}

func main() {
	var cfg config
	flag.StringVar(&cfg.url, "url", "ws://localhost:8080/ws", "server WebSocket URL")
	flag.IntVar(&cfg.n, "n", 50, "number of bots")
	flag.DurationVar(&cfg.duration, "duration", 60*time.Second, "test duration")
	flag.DurationVar(&cfg.step, "step", 200*time.Millisecond, "interval between moves per bot")
	flag.Parse()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := run(ctx, cfg, os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

type stats struct {
	connected atomic.Int64
	failed    atomic.Int64
	received  atomic.Int64
	sent      atomic.Int64

	mu        sync.Mutex
	latencies []time.Duration
}

func (s *stats) record(lat []time.Duration) {
	s.mu.Lock()
	s.latencies = append(s.latencies, lat...)
	s.mu.Unlock()
}

func run(ctx context.Context, cfg config, out io.Writer) error {
	ctx, cancel := context.WithTimeout(ctx, cfg.duration)
	defer cancel()

	var st stats
	start := time.Now()
	var wg sync.WaitGroup
	for i := range cfg.n {
		wg.Go(func() {
			if err := runBot(ctx, cfg, fmt.Sprintf("bot-%d", i), &st); err != nil {
				st.failed.Add(1)
				fmt.Fprintf(out, "bot-%d: %v\n", i, err)
			}
		})
	}
	wg.Wait()
	elapsed := time.Since(start)

	slices.Sort(st.latencies)
	fmt.Fprintf(out, "bots:     %d connected, %d failed\n", st.connected.Load(), st.failed.Load())
	fmt.Fprintf(out, "moves:    %d sent, %d acked\n", st.sent.Load(), len(st.latencies))
	fmt.Fprintf(out, "messages: %d received, %.0f/s\n", st.received.Load(), float64(st.received.Load())/elapsed.Seconds())
	fmt.Fprintf(out, "ack latency: p50=%v p95=%v p99=%v max=%v\n",
		percentile(st.latencies, 0.50), percentile(st.latencies, 0.95),
		percentile(st.latencies, 0.99), percentile(st.latencies, 1))

	if n := st.failed.Load(); n > 0 {
		return fmt.Errorf("%d bots failed", n)
	}
	return nil
}

type pendingMove struct {
	seq    uint32
	sentAt time.Time
}

func runBot(ctx context.Context, cfg config, name string, st *stats) error {
	conn, _, err := websocket.Dial(ctx, cfg.url+"?name="+name, nil)
	if err != nil {
		return fmt.Errorf("dial: %w", err)
	}
	defer conn.CloseNow()
	if _, _, err := conn.Read(ctx); err != nil {
		return fmt.Errorf("read welcome: %w", err)
	}
	st.connected.Add(1)
	st.received.Add(1)

	var (
		mu      sync.Mutex
		pending []pendingMove
	)
	readErr := make(chan error, 1)
	go func() {
		for {
			// Not ctx: canceling a read tears the connection down before
			// the close handshake below can run.
			_, b, err := conn.Read(context.Background())
			if err != nil {
				readErr <- err
				return
			}
			st.received.Add(1)
			var msg struct {
				T string `json:"t"`
				D struct {
					Ack uint32 `json:"ack"`
				} `json:"d"`
			}
			if err := json.Unmarshal(b, &msg); err != nil || msg.T != "state" {
				continue
			}
			now := time.Now()
			mu.Lock()
			n := 0
			var lat []time.Duration
			for ; n < len(pending) && pending[n].seq <= msg.D.Ack; n++ {
				lat = append(lat, now.Sub(pending[n].sentAt))
			}
			pending = pending[n:]
			mu.Unlock()
			st.record(lat)
		}
	}()

	ticker := time.NewTicker(cfg.step)
	defer ticker.Stop()
	dir := dirs[rand.IntN(len(dirs))]
	var seq uint32
	for {
		select {
		case <-ctx.Done():
			conn.Close(websocket.StatusNormalClosure, "")
			return nil
		case err := <-readErr:
			if ctx.Err() != nil {
				return nil
			}
			return fmt.Errorf("read: %w", err)
		case <-ticker.C:
			if rand.IntN(4) == 0 {
				dir = dirs[rand.IntN(len(dirs))]
			}
			seq++
			msg := fmt.Appendf(nil, `{"t":"move","d":{"seq":%d,"dir":%q}}`, seq, dir)
			mu.Lock()
			pending = append(pending, pendingMove{seq, time.Now()})
			mu.Unlock()
			if err := conn.Write(ctx, websocket.MessageText, msg); err != nil {
				if ctx.Err() != nil {
					return nil
				}
				return fmt.Errorf("write: %w", err)
			}
			st.sent.Add(1)
		}
	}
}

func percentile(sorted []time.Duration, p float64) time.Duration {
	if len(sorted) == 0 {
		return 0
	}
	return sorted[int(p*float64(len(sorted)-1))]
}
