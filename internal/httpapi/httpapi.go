// Package httpapi wires the HTTP routes of the office server.
package httpapi

import (
	"io/fs"
	"net/http"
	"strings"
	"time"
)

type Options struct {
	WS http.Handler
	// Ready reports whether the server accepts new sessions. It turns false
	// when shutdown starts, before sessions are closed.
	Ready   func() bool
	MapsDir string
	WebDir  string
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
	mux.Handle("GET /maps/", http.StripPrefix("/maps/", tiledJSON(http.FileServer(filesOnly{http.Dir(opts.MapsDir)}))))
	mux.Handle("GET /", http.FileServer(filesOnly{http.Dir(opts.WebDir)}))
	return http.NewCrossOriginProtection().Handler(mux)
}

func writeText(w http.ResponseWriter, status int, body string) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write([]byte(body + "\n"))
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
