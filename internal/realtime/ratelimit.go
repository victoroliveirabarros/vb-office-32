package realtime

import (
	"sync"
	"time"
)

const (
	messageRate  = 20
	messageBurst = 40

	// Chats also count against messageRate, like every message. The chat
	// bucket belongs to the identity, so reconnecting does not refill it.
	chatRate  = 0.5
	chatBurst = 5

	// everyoneRate caps the everyone chats of a whole room, so many
	// senders together cannot outrun the recipients' send buffers.
	everyoneRate  = 20
	everyoneBurst = 40

	// chatSweep is how often chatLimits drops the buckets that refilled.
	chatSweep = time.Minute
)

// tokenBucket is not safe for concurrent use: a session's readLoop, a room
// goroutine or a lock owns each one.
type tokenBucket struct {
	rate   float64
	burst  float64
	tokens float64
	last   time.Time
}

func newTokenBucket(rate, burst float64) tokenBucket {
	return tokenBucket{rate: rate, burst: burst, tokens: burst}
}

func (b *tokenBucket) allow(now time.Time) bool {
	b.refill(now)
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

func (b *tokenBucket) refill(now time.Time) {
	if !b.last.IsZero() {
		b.tokens = min(b.burst, b.tokens+now.Sub(b.last).Seconds()*b.rate)
	}
	b.last = now
}

// full reports whether the bucket is as good as a new one at now.
func (b *tokenBucket) full(now time.Time) bool {
	return b.tokens+now.Sub(b.last).Seconds()*b.rate >= b.burst
}

// chatLimits holds one chat bucket per identity, shared by all of its
// connections. A bucket that refilled is the same as none, so a sweep at
// most every chatSweep, run by allow itself, forgets it.
type chatLimits struct {
	mu      sync.Mutex
	buckets map[string]*tokenBucket
	sweptAt time.Time
}

func newChatLimits() *chatLimits {
	return &chatLimits{buckets: make(map[string]*tokenBucket)}
}

func (l *chatLimits) allow(id string, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if now.Sub(l.sweptAt) >= chatSweep {
		l.sweptAt = now
		for k, b := range l.buckets {
			if b.full(now) {
				delete(l.buckets, k)
			}
		}
	}
	b, ok := l.buckets[id]
	if !ok {
		nb := newTokenBucket(chatRate, chatBurst)
		b = &nb
		l.buckets[id] = b
	}
	return b.allow(now)
}
