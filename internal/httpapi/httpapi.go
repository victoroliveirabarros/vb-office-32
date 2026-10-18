// Package httpapi wires the HTTP routes of the office server.
package httpapi

import (
	"io/fs"
	"net/http"
	"strings"
	"time"
)

func NewHandler(ws http.Handler, mapsDir, webDir string) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		_, _ = w.Write([]byte("ok\n"))
	})
	mux.Handle("GET /ws", ws)
	mux.Handle("GET /maps/", http.StripPrefix("/maps/", tiledJSON(http.FileServer(filesOnly{http.Dir(mapsDir)}))))
	mux.Handle("GET /", http.FileServer(filesOnly{http.Dir(webDir)}))
	return mux
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
