// Package httpapi wires the HTTP routes of the office server.
package httpapi

import (
	"encoding/json"
	"io/fs"
	"net/http"
	"strings"
	"time"

	"github.com/victoroliveirabarros/vb-office-32/internal/auth"
)

type Options struct {
	WS http.Handler
	// Ready reports whether the server accepts new sessions. It turns false
	// when shutdown starts, before sessions are closed.
	Ready   func() bool
	MapsDir string
	WebDir  string
	// OIDC enables login; nil means guest mode.
	OIDC OIDC
	// ConnectSrc lists the origins the page may connect to besides its own,
	// such as the media server.
	ConnectSrc []string
	// MediaWebhook, when set, receives the media server's webhooks.
	MediaWebhook http.Handler
	// HSTS sends Strict-Transport-Security; set it only when the public URL
	// is https.
	HSTS bool
}

type OIDC interface {
	Authenticate(r *http.Request) (auth.Identity, error)
	Login(w http.ResponseWriter, r *http.Request)
	Callback(w http.ResponseWriter, r *http.Request)
	Logout(w http.ResponseWriter, r *http.Request)
}

const (
	modeGuest = "guest"
	modeOIDC  = "oidc"
)

type sessionResponse struct {
	ID   string `json:"id,omitempty"`
	Name string `json:"name,omitempty"`
	Auth string `json:"auth"`
}

func NewHandler(opts Options) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		writeText(w, http.StatusOK, "ok")
	})
	mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, _ *http.Request) {
		if !opts.Ready() {
			writeText(w, http.StatusServiceUnavailable, "shutting down")
			return
		}
		writeText(w, http.StatusOK, "ok")
	})
	mux.Handle("GET /ws", whenReady(opts.Ready, opts.WS))
	mux.HandleFunc("GET /api/session", session(opts.OIDC))
	if opts.OIDC != nil {
		mux.HandleFunc("GET /auth/login", opts.OIDC.Login)
		mux.HandleFunc("GET /auth/callback", opts.OIDC.Callback)
		mux.HandleFunc("POST /auth/logout", opts.OIDC.Logout)
	}
	if opts.MediaWebhook != nil {
		mux.Handle("POST /livekit/webhook", opts.MediaWebhook)
	}
	mux.Handle("GET /maps/", http.StripPrefix("/maps/", tiledJSON(http.FileServer(filesOnly{http.Dir(opts.MapsDir)}))))
	mux.Handle("GET /", http.FileServer(filesOnly{http.Dir(opts.WebDir)}))
	return securityHeaders(opts, http.NewCrossOriginProtection().Handler(mux))
}

// securityHeaders sets headers every response gets. Handlers may still
// override them, as the auth pages do with their own.
func securityHeaders(opts Options, next http.Handler) http.Handler {
	csp := strings.Join([]string{
		"default-src 'self'",
		"script-src 'self'",
		"style-src 'self'",
		"img-src 'self' data: blob:",
		"media-src 'self'",
		strings.Join(append([]string{"connect-src 'self'"}, opts.ConnectSrc...), " "),
		"font-src 'self'",
		"object-src 'none'",
		"base-uri 'none'",
		"form-action 'self'",
		"frame-ancestors 'none'",
	}, "; ")
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Content-Security-Policy", csp)
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("Permissions-Policy", "camera=(self), microphone=(self), geolocation=(), display-capture=()")
		h.Set("Cross-Origin-Opener-Policy", "same-origin")
		if opts.HSTS {
			h.Set("Strict-Transport-Security", "max-age=31536000")
		}
		next.ServeHTTP(w, r)
	})
}

func writeText(w http.ResponseWriter, status int, body string) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write([]byte(body + "\n"))
}

// session tells the frontend which screen to show. Guest mode has no
// server-side session, so it always answers 401.
func session(o OIDC) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if o == nil {
			writeJSON(w, http.StatusUnauthorized, sessionResponse{Auth: modeGuest})
			return
		}
		id, err := o.Authenticate(r)
		if err != nil {
			writeJSON(w, http.StatusUnauthorized, sessionResponse{Auth: modeOIDC})
			return
		}
		writeJSON(w, http.StatusOK, sessionResponse{ID: id.ID, Name: id.Name, Auth: modeOIDC})
	}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func whenReady(ready func() bool, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !ready() {
			http.Error(w, "shutting down", http.StatusServiceUnavailable)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// filesOnly hides directories so FileServer never lists them. The root is
// still opened when it has an index.html, which FileServer then serves.
type filesOnly struct {
	root http.FileSystem
}

func (fsys filesOnly) Open(name string) (http.File, error) {
	f, err := fsys.root.Open(name)
	if err != nil {
		return nil, err
	}
	info, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, err
	}
	if info.IsDir() && (name != "/" || !fsys.hasIndex()) {
		f.Close()
		return nil, fs.ErrNotExist
	}
	return f, nil
}

func (fsys filesOnly) hasIndex() bool {
	f, err := fsys.root.Open("/index.html")
	if err != nil {
		return false
	}
	f.Close()
	return true
}

// tiledJSON sets the content type for .tmj files, which mime does not know.
func tiledJSON(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, ".tmj") {
			w.Header().Set("Content-Type", "application/json")
		}
		next.ServeHTTP(w, r)
	})
}

// NewServer has no read or write timeout because /ws connections are
// long-lived; slow headers and idle keep-alives are still bounded.
func NewServer(h http.Handler) *http.Server {
	return &http.Server{
		Handler:           h,
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    16 << 10,
	}
}
