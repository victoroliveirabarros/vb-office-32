package chat

import (
	"errors"
	"fmt"
	"strings"
	"testing"
	"unicode"
	"unicode/utf8"
)

func TestClean(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string
		err  error
	}{
		{"plain", "olá, mundo", "olá, mundo", nil},
		{"html is literal", `<script>alert("x")</script> &amp;`, `<script>alert("x")</script> &amp;`, nil},
		{"family", "👨\u200d👩\u200d👧", "👨\u200d👩\u200d👧", nil},
		{"rainbow flag", "🏳\ufe0f\u200d🌈", "🏳\ufe0f\u200d🌈", nil},
		{"skin tone", "👍\U0001f3fd 👩\U0001f3fd\u200d💻", "👍\U0001f3fd 👩\U0001f3fd\u200d💻", nil},
		{"regional flag", "🇧🇷", "🇧🇷", nil},
		{"persian zwnj", "می\u200cخواهم", "می\u200cخواهم", nil},
		{"zwj between ascii", "pa\u200dss", "pass", nil},
		{"zwnj between ascii", "a\u200cb", "ab", nil},
		{"zwj at start", "\u200d🌈", "🌈", nil},
		{"zwj at end", "🌈\u200d", "🌈", nil},
		{"zwj before space", "🌈\u200d x", "🌈 x", nil},
		{"zwj after space", "x \u200d🌈", "x 🌈", nil},
		{"repeated zwj", "👨\u200d\u200d\u200c👩", "👨\u200d👩", nil},
		{"zwj then bidi then end", "👨\u200d\u202e", "👨", nil},
		{"bidi override", "abc\u202edcba\u202c", "abcdcba", nil},
		{"bidi isolates and marks", "\u2066a\u2069\u200e\u200f\u061c", "a", nil},
		{"bom", "\ufeffhello", "hello", nil},
		{"soft hyphen", "pa\u00adlavra", "palavra", nil},
		{"zero width space", "a\u200bb", "ab", nil},
		{"tags", "🏴\U000e0067\U000e0062\U000e0065\U000e006e\U000e0067\U000e007f", "🏴", nil},
		{"controls", "a\x00b\x07c\x1bd\x7fe\u0080f\u009f", "abcdef", nil},
		{"tab", "a\tb", "a b", nil},
		{"blank letters are spaces", "a\u3164b\u2800c\u115fd\u1160e\uffa0f", "a b c d e f", nil},
		{"blank letters trimmed", "\u3164\u2800oi\uffa0\n\u115f", "oi", nil},
		{"only blank letters", "\u3164\u2800\u115f\u1160\uffa0\n\u3164", "", ErrEmpty},
		{"crlf", "a\r\nb\rc", "a\nb\nc", nil},
		{"unicode breaks", "a\u0085b\u2028c\u2029d", "a\nb\nc\nd", nil},
		{"trailing spaces per line", "a  \nb\u00a0\t\nc", "a\nb\nc", nil},
		{"leading indent kept", "a\n  b", "a\n  b", nil},
		{"breaks collapse", "a\n\n\n\n\n\nb", "a\n\n\nb", nil},
		{"breaks of blank lines collapse", "a\n \n \n \n \nb", "a\n\n\nb", nil},
		{"three breaks kept", "a\n\n\nb", "a\n\n\nb", nil},
		{"trim", "  \n hi \n\n ", "hi", nil},
		{"invalid utf8", "a\xffb\xc0", "a\ufffdb\ufffd", nil},
		{"empty", "", "", ErrEmpty},
		{"only spaces", " \n\t\r\n ", "", ErrEmpty},
		{"only format", "\u202e\u200d\ufeff\u200b", "", ErrEmpty},
		{"500 runes", strings.Repeat("é", MaxRunes), strings.Repeat("é", MaxRunes), nil},
		{"501 runes", strings.Repeat("é", MaxRunes+1), "", ErrTooLong},
		{"501 runes before cleaning", strings.Repeat("a", MaxRunes) + "\u202e", strings.Repeat("a", MaxRunes), nil},
		{"2000 four-byte runes", strings.Repeat("𝕏", 2000), "", ErrTooLong},
		{"20 lines", strings.Repeat("a\n", MaxLines-1) + "a", strings.Repeat("a\n", MaxLines-1) + "a", nil},
		{"21 lines", strings.Repeat("a\n", MaxLines) + "a", "", ErrTooLong},
		{"blank lines count", strings.Repeat("a\n\n", 10) + "a", "", ErrTooLong},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := Clean(tt.in)
			if !errors.Is(err, tt.err) || got != tt.want {
				t.Errorf("Clean(%+q) = %+q, %v; want %+q, %v", tt.in, got, err, tt.want, tt.err)
			}
		})
	}
}

func FuzzClean(f *testing.F) {
	for _, s := range []string{
		"olá", "👨\u200d👩\u200d👧", "🏳\ufe0f\u200d🌈", "می\u200cخواهم", "a\u200d\u200d\n", "\u202ex\r\n\r\n\r\n\r\ny",
		"<b>x</b>", "a\xffb", "\t\u2028 \u0085", "🌈\u200d\u202e", " \u200d\u00a0\u200d🌈", "\u3164\u2800\u115f\u1160\uffa0",
	} {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, in string) {
		out, err := Clean(in)
		if err != nil {
			if !errors.Is(err, ErrEmpty) && !errors.Is(err, ErrTooLong) {
				t.Fatalf("unexpected error %v", err)
			}
			return
		}
		if !utf8.ValidString(out) {
			t.Fatalf("invalid UTF-8 %+q", out)
		}
		if out != strings.TrimSpace(out) || strings.Contains(out, "\n\n\n\n") {
			t.Fatalf("untrimmed or too many breaks: %+q", out)
		}
		if utf8.RuneCountInString(out) > MaxRunes || strings.Count(out, "\n") >= MaxLines {
			t.Fatalf("over the limits: %+q", out)
		}
		for _, r := range out {
			if r != '\n' && unicode.Is(unicode.Cc, r) {
				t.Fatalf("control %U in %+q", r, out)
			}
			if r != zwj && r != zwnj && unicode.Is(unicode.Cf, r) {
				t.Fatalf("format %U in %+q", r, out)
			}
			if strings.ContainsRune("\u115f\u1160\u2800\u3164\uffa0", r) {
				t.Fatalf("blank letter %U in %+q", r, out)
			}
		}
		again, err := Clean(out)
		if err != nil || again != out {
			t.Fatalf("not idempotent: %+q -> %+q, %v", out, again, err)
		}
	})
}

func TestScopeValid(t *testing.T) {
	for _, s := range []Scope{Everyone, Nearby, Direct} {
		if !s.Valid() {
			t.Errorf("%q invalid", s)
		}
	}
	for _, s := range []Scope{"", "all", "Everyone", "dm"} {
		if s.Valid() {
			t.Errorf("%q valid", s)
		}
	}
}

func TestHistory(t *testing.T) {
	var h History
	if ms := h.Messages(); ms == nil || len(ms) != 0 {
		t.Fatalf("empty history = %#v, want empty non-nil", ms)
	}
	for i := range 3 {
		h.Add(Message{ID: fmt.Sprint(i)})
	}
	if got := ids(h.Messages()); got != "0 1 2" {
		t.Errorf("messages = %s, want 0 1 2", got)
	}

	for i := 3; i < HistorySize+5; i++ {
		h.Add(Message{ID: fmt.Sprint(i)})
	}
	ms := h.Messages()
	if len(ms) != HistorySize || ms[0].ID != "5" || ms[len(ms)-1].ID != fmt.Sprint(HistorySize+4) {
		t.Fatalf("after %d adds: %d messages from %s to %s, want %d from 5 to %d",
			HistorySize+5, len(ms), ms[0].ID, ms[len(ms)-1].ID, HistorySize, HistorySize+4)
	}
	for i := 1; i < len(ms); i++ {
		if ms[i].ID != fmt.Sprint(i+5) {
			t.Fatalf("messages out of order: %s", ids(ms))
		}
	}

	ms[0].ID = "changed"
	if h.Messages()[0].ID != "5" {
		t.Error("Messages shares memory with the history")
	}
}

func ids(ms []Message) string {
	s := make([]string, len(ms))
	for i, m := range ms {
		s[i] = m.ID
	}
	return strings.Join(s, " ")
}

func TestIDs(t *testing.T) {
	a, b := NewIDs(), NewIDs()
	if a.prefix == b.prefix {
		t.Errorf("two boots share the prefix %q", a.prefix)
	}
	seen := make(map[string]bool)
	for i := range 40 {
		id := a.Next()
		if seen[id] {
			t.Fatalf("duplicate id %q", id)
		}
		seen[id] = true
		if i == 35 && id != a.prefix+"-10" {
			t.Errorf("36th id = %q, want base-36 counter %q", id, a.prefix+"-10")
		}
	}
	if first := b.Next(); first != b.prefix+"-1" || len(b.prefix) != 8 || strings.ToLower(b.prefix) != b.prefix {
		t.Errorf("first id = %q", first)
	}
}
