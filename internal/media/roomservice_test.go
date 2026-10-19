package media

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"slices"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func TestHTTPURL(t *testing.T) {
	for in, want := range map[string]string{
		"ws://localhost:7880":     "http://localhost:7880",
		"wss://media.example":     "https://media.example",
		"wss://media.example:443": "https://media.example:443",
	} {
		if got := HTTPURL(in); got != want {
			t.Errorf("HTTPURL(%q) = %q, want %q", in, got, want)
		}
	}
}

// roomService answers room service calls with the statuses in order,
// repeating the last one.
func roomService(t *testing.T, statuses ...int) (*Client, *atomic.Int32) {
	t.Helper()
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := int(calls.Add(1))
		status := statuses[min(n, len(statuses))-1]
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		switch status {
		case http.StatusOK:
			io.WriteString(w, "{}")
		case http.StatusNotFound:
			io.WriteString(w, `{"code":"not_found","msg":"participant not found"}`)
		case http.StatusUnauthorized:
			io.WriteString(w, `{"code":"unauthenticated","msg":"permissions denied"}`)
		default:
			io.WriteString(w, `{"code":"internal","msg":"boom"}`)
		}
	}))
	t.Cleanup(srv.Close)
	return NewClient("ws"+strings.TrimPrefix(srv.URL, "http"), "key", "s3cr3t"), &calls
}

func TestRemoveRequest(t *testing.T) {
	var req *http.Request
	var body []byte
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		req = r
		body, _ = io.ReadAll(r.Body)
		io.WriteString(w, "{}")
	}))
	defer srv.Close()
	c := NewClient("ws"+strings.TrimPrefix(srv.URL, "http"), "key", "s3cr3t")

	before := time.Now().Unix()
	if found, err := c.Remove(context.Background(), "office", "oidc:42"); err != nil || !found {
		t.Fatalf("Remove = %v, %v", found, err)
	}
	if req.Method != http.MethodPost || req.URL.Path != "/twirp/livekit.RoomService/RemoveParticipant" ||
		req.Header.Get("Content-Type") != "application/json" {
		t.Errorf("request = %s %s %q", req.Method, req.URL.Path, req.Header.Get("Content-Type"))
	}
	if string(body) != `{"room":"office","identity":"oidc:42"}` {
		t.Errorf("body = %s", body)
	}

	checkAdminToken(t, req, "office", before)
}

// checkAdminToken checks that req carries a one-minute HS256 token issued
// now that administers room and nothing else.
func checkAdminToken(t *testing.T, req *http.Request, room string, before int64) {
	t.Helper()
	token, ok := strings.CutPrefix(req.Header.Get("Authorization"), "Bearer ")
	parts := strings.Split(token, ".")
	if !ok || len(parts) != 3 {
		t.Fatalf("authorization = %q, want a bearer JWT", req.Header.Get("Authorization"))
	}
	mac := hmac.New(sha256.New, []byte("s3cr3t"))
	mac.Write([]byte(parts[0] + "." + parts[1]))
	if decode(t, parts[0]) != `{"alg":"HS256","typ":"JWT"}` || !hmac.Equal([]byte(decode(t, parts[2])), mac.Sum(nil)) {
		t.Error("admin token is not HS256 with the API secret")
	}
	var claims map[string]json.RawMessage
	if err := json.Unmarshal([]byte(decode(t, parts[1])), &claims); err != nil {
		t.Fatal(err)
	}
	if string(claims["iss"]) != `"key"` || string(claims["video"]) != `{"room":"`+room+`","roomAdmin":true}` || len(claims) != 5 {
		t.Errorf("claims = %s, want iss, nbf, iat, exp and video with only room and roomAdmin", decode(t, parts[1]))
	}
	var c adminClaims
	if err := json.Unmarshal([]byte(decode(t, parts[1])), &c); err != nil {
		t.Fatal(err)
	}
	if c.Exp-c.Nbf != 60 || c.Nbf < before || c.Nbf > time.Now().Unix() {
		t.Errorf("nbf = %d, exp = %d, want a one-minute token issued now", c.Nbf, c.Exp)
	}
}

func TestParticipantsRequest(t *testing.T) {
	var req *http.Request
	var body []byte
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		req = r
		body, _ = io.ReadAll(r.Body)
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"participants":[{"sid":"PA_1","identity":"oidc:42","state":"ACTIVE","tracks":[]},{"identity":"intruder"}]}`)
	}))
	defer srv.Close()
	c := NewClient("ws"+strings.TrimPrefix(srv.URL, "http"), "key", "s3cr3t")

	before := time.Now().Unix()
	ids, err := c.Participants(context.Background(), "office")
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(ids, []string{"oidc:42", "intruder"}) {
		t.Errorf("participants = %q", ids)
	}
	if req.Method != http.MethodPost || req.URL.Path != "/twirp/livekit.RoomService/ListParticipants" ||
		req.Header.Get("Content-Type") != "application/json" {
		t.Errorf("request = %s %s %q", req.Method, req.URL.Path, req.Header.Get("Content-Type"))
	}
	if string(body) != `{"room":"office"}` {
		t.Errorf("body = %s", body)
	}
	checkAdminToken(t, req, "office", before)
}

func TestParticipantsStatuses(t *testing.T) {
	tests := []struct {
		name   string
		status int
		ok     bool
	}{
		{"no room", 404, true},
		{"refused", 401, false},
		{"not retried", 503, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			c, calls := roomService(t, tt.status)
			ids, err := c.Participants(context.Background(), "office")
			if tt.ok != (err == nil) || len(ids) != 0 {
				t.Errorf("Participants = %q, %v, want none and ok = %v", ids, err, tt.ok)
			}
			if n := calls.Load(); n != 1 {
				t.Errorf("calls = %d, want 1", n)
			}
			if err != nil && strings.Contains(err.Error(), "Bearer") {
				t.Errorf("error %q carries the token", err)
			}
		})
	}
}

func TestRemoveStatuses(t *testing.T) {
	tests := []struct {
		name     string
		statuses []int
		found    bool
		ok       bool
		calls    int32
	}{
		{"removed", []int{200}, true, true, 1},
		{"already gone", []int{404}, false, true, 1},
		{"retried once", []int{503, 200}, true, true, 2},
		{"retried once only", []int{500}, false, false, 2},
		{"refused", []int{401}, false, false, 1},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			c, calls := roomService(t, tt.statuses...)
			found, err := c.Remove(context.Background(), "office", "guest:ana")
			if tt.ok != (err == nil) || found != tt.found {
				t.Errorf("Remove = %v, %v, want found = %v, ok = %v", found, err, tt.found, tt.ok)
			}
			if n := calls.Load(); n != tt.calls {
				t.Errorf("calls = %d, want %d", n, tt.calls)
			}
			if err != nil && strings.Contains(err.Error(), "Bearer") {
				t.Errorf("error %q carries the token", err)
			}
		})
	}
}

func TestRemoveNetworkError(t *testing.T) {
	srv := httptest.NewServer(http.NotFoundHandler())
	srv.Close()
	c := NewClient("ws"+strings.TrimPrefix(srv.URL, "http"), "key", "s3cr3t")
	start := time.Now()
	if _, err := c.Remove(context.Background(), "office", "guest:ana"); err == nil {
		t.Fatal("Remove succeeded against a closed server")
	}
	if time.Since(start) < retryDelay {
		t.Error("Remove did not retry after a network error")
	}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	start = time.Now()
	if _, err := c.Remove(ctx, "office", "guest:ana"); err == nil || time.Since(start) >= retryDelay {
		t.Errorf("Remove with a canceled context = %v after %v, want an error at once", err, time.Since(start))
	}
}

// TestLiveKitRemove connects a participant to a real LiveKit server with one
// of our tokens and removes it, e.g.
//
//	docker run --rm --network host livekit/livekit-server:v1.13 --dev --bind 127.0.0.1
//	VB_OFFICE32_LIVEKIT_TEST_URL=http://localhost:7880 go test -run LiveKit ./internal/media
func TestLiveKitRemove(t *testing.T) {
	base := os.Getenv("VB_OFFICE32_LIVEKIT_TEST_URL")
	if base == "" {
		t.Skip("VB_OFFICE32_LIVEKIT_TEST_URL not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	wsURL := "ws" + strings.TrimPrefix(base, "http")
	c := NewClient(wsURL, "devkey", "secret")
	room := "remove-test-" + strconv.FormatInt(time.Now().UnixNano(), 36)
	identity := "guest:ana"

	g, err := c.Issue(identity, "Ana", room, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	conn, _, err := websocket.Dial(ctx, wsURL+"/rtc?protocol=16&access_token="+url.QueryEscape(g.Token), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.CloseNow()
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

	waitFor(t, ctx, func() bool { return slices.Contains(listParticipants(t, ctx, c, room), identity) })
	if found, err := c.Remove(ctx, room, identity); err != nil || !found {
		t.Fatalf("Remove = %v, %v", found, err)
	}
	waitFor(t, ctx, func() bool { return !slices.Contains(listParticipants(t, ctx, c, room), identity) })
	select {
	case <-closed:
	case <-ctx.Done():
		t.Error("signal connection still open after removal")
	}
	if found, err := c.Remove(ctx, room, identity); err != nil || found {
		t.Errorf("removing a participant that is gone = %v, %v", found, err)
	}
}

func waitFor(t *testing.T, ctx context.Context, ok func() bool) {
	t.Helper()
	for !ok() {
		select {
		case <-ctx.Done():
			t.Fatal("condition not met before the deadline")
		case <-time.After(100 * time.Millisecond):
		}
	}
}

func listParticipants(t *testing.T, ctx context.Context, c *Client, room string) []string {
	t.Helper()
	ids, err := c.Participants(ctx, room)
	if err != nil {
		t.Fatal(err)
	}
	return ids
}
