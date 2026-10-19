package realtime

import "time"

const (
	messageRate  = 20
	messageBurst = 40

	// Chats also count against messageRate, like every message.
	chatRate  = 0.5
	chatBurst = 5
)

// tokenBucket is not safe for concurrent use; only a session's readLoop
// calls allow.
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
	if !b.last.IsZero() {
		b.tokens = min(b.burst, b.tokens+now.Sub(b.last).Seconds()*b.rate)
	}
	b.last = now
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}
