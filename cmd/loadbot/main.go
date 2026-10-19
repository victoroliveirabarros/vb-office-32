// Command loadbot connects random-walking bots to a vb-office-32 server and
// reports ack latency; with -chat they also chat and it reports the echo
// latency.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"maps"
	"math/rand/v2"
	"os"
	"os/signal"
	"slices"
	"strconv"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/coder/websocket"
)

var dirs = [...]string{"up", "down", "left", "right"}

// readLimit fits the largest server message, a chatHistory of 100 chats of
// up to 500 runes, about 200 KiB; the library default of 32 KiB does not.
const readLimit = 1 << 20

type config struct {
	url      string
	n        int
	duration time.Duration
	step     time.Duration
	chat     bool
	// chatEvery stays above the server's 2 s per chat, so bots do not get
	// rate_limited.
	chatEvery time.Duration
}

func main() {
	var cfg config
	flag.StringVar(&cfg.url, "url", "ws://localhost:8080/ws", "server WebSocket URL")
	flag.IntVar(&cfg.n, "n", 50, "number of bots")
	flag.DurationVar(&cfg.duration, "duration", 60*time.Second, "test duration")
	flag.DurationVar(&cfg.step, "step", 200*time.Millisecond, "interval between moves per bot")
	flag.BoolVar(&cfg.chat, "chat", false, "bots also chat (everyone, nearby and direct)")
	flag.DurationVar(&cfg.chatEvery, "chat-every", 3*time.Second, "interval between chats per bot")
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

	chatSent      atomic.Int64
	chatDelivered atomic.Int64

	mu         sync.Mutex
	latencies  []time.Duration
	echoes     []time.Duration
	chatErrors map[string]int
}

func (s *stats) record(lat []time.Duration) {
	s.mu.Lock()
	s.latencies = append(s.latencies, lat...)
	s.mu.Unlock()
}

func (s *stats) recordEcho(lat time.Duration) {
	s.mu.Lock()
	s.echoes = append(s.echoes, lat)
	s.mu.Unlock()
}

func (s *stats) recordChatError(reason string) {
	s.mu.Lock()
	if s.chatErrors == nil {
		s.chatErrors = make(map[string]int)
	}
	s.chatErrors[reason]++
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
			if err := runBot(ctx, cfg, i, &st); err != nil {
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
	if cfg.chat {
		slices.Sort(st.echoes)
		fmt.Fprintf(out, "chat:     %d sent, %d echoed, %d delivered to others\n",
			st.chatSent.Load(), len(st.echoes), st.chatDelivered.Load())
		for _, reason := range slices.Sorted(maps.Keys(st.chatErrors)) {
			fmt.Fprintf(out, "chat error %s: %d\n", reason, st.chatErrors[reason])
		}
		fmt.Fprintf(out, "echo latency: p50=%v p95=%v p99=%v max=%v\n",
			percentile(st.echoes, 0.50), percentile(st.echoes, 0.95),
			percentile(st.echoes, 0.99), percentile(st.echoes, 1))
	}

	if n := st.failed.Load(); n > 0 {
		return fmt.Errorf("%d bots failed", n)
	}
	return nil
}

type pendingMove struct {
	seq    uint32
	sentAt time.Time
}

func runBot(ctx context.Context, cfg config, i int, st *stats) error {
	name := fmt.Sprintf("bot-%d", i)
	conn, _, err := websocket.Dial(ctx, cfg.url+"?name="+name, nil)
	if err != nil {
		return fmt.Errorf("dial: %w", err)
	}
	defer conn.CloseNow()
	conn.SetReadLimit(readLimit)
	if _, _, err := conn.Read(ctx); err != nil {
		return fmt.Errorf("read welcome: %w", err)
	}
	st.connected.Add(1)
	st.received.Add(1)

	var (
		mu      sync.Mutex
		pending []pendingMove
		chats   = make(map[string]time.Time)
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
					Ack    uint32 `json:"ack"`
					CID    string `json:"cid"`
					Reason string `json:"reason"`
				} `json:"d"`
			}
			if err := json.Unmarshal(b, &msg); err != nil {
				continue
			}
			now := time.Now()
			switch msg.T {
			case "chat":
				if msg.D.CID == "" {
					st.chatDelivered.Add(1)
					continue
				}
				mu.Lock()
				sentAt, ok := chats[msg.D.CID]
				delete(chats, msg.D.CID)
				mu.Unlock()
				if ok {
					st.recordEcho(now.Sub(sentAt))
				}
				continue
			case "chatError":
				mu.Lock()
				delete(chats, msg.D.CID)
				mu.Unlock()
				st.recordChatError(msg.D.Reason)
				continue
			}
			if msg.T != "state" {
				continue
			}
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
	// The first chat comes at a random point of the interval, spreading the
	// bots over it.
	var chatC <-chan time.Time
	if cfg.chat {
		chatC = time.After(rand.N(cfg.chatEvery))
	}
	dir := dirs[rand.IntN(len(dirs))]
	var seq uint32
	var chatN int
	write := func(msg []byte) error {
		err := conn.Write(ctx, websocket.MessageText, msg)
		if err != nil && ctx.Err() == nil {
			return fmt.Errorf("write: %w", err)
		}
		return nil
	}
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
			if err := write(msg); err != nil {
				return err
			}
			st.sent.Add(1)
		case <-chatC:
			chatC = time.After(cfg.chatEvery)
			chatN++
			cid := strconv.Itoa(chatN)
			msg, err := chatMessage(cid, name, i, cfg.n)
			if err != nil {
				return err
			}
			mu.Lock()
			chats[cid] = time.Now()
			mu.Unlock()
			if err := write(msg); err != nil {
				return err
			}
			st.chatSent.Add(1)
		}
	}
}

// chatMessage goes to everyone 70% of the time, to the bots nearby 20% and
// to another bot directly 10%.
func chatMessage(cid, name string, i, n int) ([]byte, error) {
	type chat struct {
		CID   string `json:"cid"`
		Scope string `json:"scope"`
		To    string `json:"to,omitempty"`
		Text  string `json:"text"`
	}
	c := chat{CID: cid, Scope: "everyone", Text: fmt.Sprintf("%s diz olá #%s 👋", name, cid)}
	switch p := rand.IntN(10); {
	case p < 2:
		c.Scope = "nearby"
	case p < 3 && n > 1:
		c.Scope = "direct"
		c.To = fmt.Sprintf("guest:bot-%d", (i+1+rand.IntN(n-1))%n)
	}
	return json.Marshal(struct {
		T string `json:"t"`
		D chat   `json:"d"`
	}{"chat", c})
}

func percentile(sorted []time.Duration, p float64) time.Duration {
	if len(sorted) == 0 {
		return 0
	}
	return sorted[int(p*float64(len(sorted)-1))]
}
