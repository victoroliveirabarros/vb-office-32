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

	// Valid appearance changes have their own bucket per identity, so a
	// client cannot make everyone redraw avatars nonstop.
	appearanceRate  = 0.2
	appearanceBurst = 3

	// Desk invites and revocations share the chat limits, per identity.
	deskRate  = chatRate
	deskBurst = chatBurst

	// everyoneRate caps the everyone chats of a whole room, so many
	// senders together cannot outrun the recipients' send buffers.
	everyoneRate  = 20
	everyoneBurst = 40

	// limitSweep is how often identityLimits drops the buckets that
	// refilled.
	limitSweep = time.Minute
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

// identityLimits holds one bucket per identity, shared by all of its
// connections. A bucket that refilled is the same as none, so a sweep at
// most every limitSweep, run by allow itself, forgets it.
type identityLimits struct {
	rate    float64
	burst   float64
	mu      sync.Mutex
	buckets map[string]*tokenBucket
	sweptAt time.Time
}

func newIdentityLimits(rate, burst float64) *identityLimits {
	return &identityLimits{rate: rate, burst: burst, buckets: make(map[string]*tokenBucket)}
}

func (l *identityLimits) allow(id string, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if now.Sub(l.sweptAt) >= limitSweep {
		l.sweptAt = now
		for k, b := range l.buckets {
			if b.full(now) {
				delete(l.buckets, k)
			}
		}
	}
	b, ok := l.buckets[id]
	if !ok {
		nb := newTokenBucket(l.rate, l.burst)
		b = &nb
		l.buckets[id] = b
	}
	return b.allow(now)
}

// sessionLimits are the identity buckets every session of a handler shares.
type sessionLimits struct {
	chat       *identityLimits
	appearance *identityLimits
	desk       *identityLimits
}

func newSessionLimits() sessionLimits {
	return sessionLimits{
		chat:       newIdentityLimits(chatRate, chatBurst),
		appearance: newIdentityLimits(appearanceRate, appearanceBurst),
		desk:       newIdentityLimits(deskRate, deskBurst),
	}
}
