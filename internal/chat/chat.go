// Package chat holds the pure parts of the text chat: scopes, text
// cleaning, the everyone history and message IDs. It has no goroutines,
// clocks or encoding; the realtime room drives it.
package chat

import (
	"crypto/rand"
	"errors"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

const (
	MaxRunes    = 500
	MaxLines    = 20
	HistorySize = 100

	// maxBreaks is how many line breaks in a row survive Clean.
	maxBreaks = 3

	zwnj = '\u200c'
	zwj  = '\u200d'
)

var (
	ErrEmpty   = errors.New("empty")
	ErrTooLong = errors.New("too long")
)

type Scope string

const (
	Everyone Scope = "everyone"
	Nearby   Scope = "nearby"
	Direct   Scope = "direct"
)

func (s Scope) Valid() bool {
	switch s {
	case Everyone, Nearby, Direct:
		return true
	}
	return false
}

// Message is a chat message as the room routes it. To is set only for
// Direct.
type Message struct {
	ID       string
	At       time.Time
	From     string
	FromName string
	Scope    Scope
	To       string
	Text     string
}

// spaces maps line breaks to \n, and the tab and the blank letters (Hangul
// fillers, the empty braille pattern), which render as space but are not
// unicode.IsSpace, to a plain space, so text made only of them is empty.
var spaces = strings.NewReplacer(
	"\r\n", "\n",
	"\r", "\n",
	"\u0085", "\n",
	"\u2028", "\n",
	"\u2029", "\n",
	"\t", " ",
	"\u115f", " ",
	"\u1160", " ",
	"\u2800", " ",
	"\u3164", " ",
	"\uffa0", " ",
)

// Clean makes text safe to show as is: valid UTF-8, \n as the only control,
// blank letters turned into spaces, no format characters (bidi overrides, BOM, soft hyphen, tags) except a
// joiner inside a word or emoji sequence, no trailing spaces on a line, at
// most three breaks in a row and no surrounding space. It rejects text that
// ends up empty, longer than MaxRunes or with more than MaxLines lines,
// instead of truncating it.
func Clean(text string) (string, error) {
	rs := []rune(spaces.Replace(strings.ToValidUTF8(text, "\ufffd")))
	rs = dropControls(rs)
	rs = keepJoiners(rs)

	lines := strings.Split(string(rs), "\n")
	for i, l := range lines {
		lines[i] = strings.TrimRightFunc(l, unicode.IsSpace)
	}
	s := strings.TrimSpace(collapseBreaks(strings.Join(lines, "\n")))

	switch {
	case s == "":
		return "", ErrEmpty
	case utf8.RuneCountInString(s) > MaxRunes, strings.Count(s, "\n") >= MaxLines:
		return "", ErrTooLong
	}
	return s, nil
}

// dropControls removes every Cc but \n and every Cf but the joiners, which
// keepJoiners judges in context.
func dropControls(rs []rune) []rune {
	out := rs[:0]
	for _, r := range rs {
		switch {
		case r == '\n', r == zwj, r == zwnj:
		case unicode.Is(unicode.Cc, r), unicode.Is(unicode.Cf, r):
			continue
		}
		out = append(out, r)
	}
	return out
}

// keepJoiners keeps a ZWJ or ZWNJ only between two non-space runes where the
// one before is not ASCII: emoji sequences, flags with modifiers and Persian
// words keep theirs, while one between ASCII letters, at an edge or next to
// a space only hides text. Repeated joiners collapse into the first.
func keepJoiners(rs []rune) []rune {
	out := rs[:0]
	for i, r := range rs {
		if r != zwj && r != zwnj {
			out = append(out, r)
			continue
		}
		if len(out) == 0 {
			continue
		}
		prev := out[len(out)-1]
		if prev < utf8.RuneSelf || unicode.IsSpace(prev) || unicode.Is(unicode.Cf, prev) {
			continue
		}
		if next, ok := nextNonJoiner(rs[i+1:]); ok && !unicode.IsSpace(next) {
			out = append(out, r)
		}
	}
	return out
}

func nextNonJoiner(rs []rune) (rune, bool) {
	for _, r := range rs {
		if r != zwj && r != zwnj {
			return r, true
		}
	}
	return 0, false
}

func collapseBreaks(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	n := 0
	for _, r := range s {
		if r == '\n' {
			n++
			if n > maxBreaks {
				continue
			}
		} else {
			n = 0
		}
		b.WriteRune(r)
	}
	return b.String()
}

// History keeps the last HistorySize messages.
type History struct {
	buf   [HistorySize]Message
	start int
	n     int
}

func (h *History) Add(m Message) {
	if h.n < len(h.buf) {
		h.buf[(h.start+h.n)%len(h.buf)] = m
		h.n++
		return
	}
	h.buf[h.start] = m
	h.start = (h.start + 1) % len(h.buf)
}

// Messages returns a copy, oldest first, never nil.
func (h *History) Messages() []Message {
	ms := make([]Message, h.n)
	for i := range ms {
		ms[i] = h.buf[(h.start+i)%len(h.buf)]
	}
	return ms
}

// IDs makes message IDs unique across restarts: a random prefix drawn at
// boot and a base-36 counter. Not safe for concurrent use.
type IDs struct {
	prefix string
	n      uint64
}

func NewIDs() *IDs {
	return &IDs{prefix: strings.ToLower(rand.Text()[:8])}
}

func (g *IDs) Next() string {
	g.n++
	return g.prefix + "-" + strconv.FormatUint(g.n, 36)
}
