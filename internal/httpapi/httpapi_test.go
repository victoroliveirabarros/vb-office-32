package httpapi

import (
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestHandler(t *testing.T) {
	maps, web := t.TempDir(), t.TempDir()
	noIndex := t.TempDir()
	write := func(dir, name, body string) {
		path := filepath.Join(dir, name)
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write(maps, "office.tmj", `{"type":"map"}`)
	write(maps, "old/office.tmj", `{"type":"map"}`)
	write(web, "index.html", "<html>office</html>")
	write(web, "assets/app.js", "app")
	write(web, "nested/index.html", "<html>nested</html>")
	write(noIndex, "app.js", "app")
	ws := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusTeapot) })
	h := NewHandler(ws, maps, web)
	noWeb := NewHandler(ws, maps, filepath.Join(web, "missing"))
	noIndexWeb := NewHandler(ws, maps, noIndex)

	tests := []struct {
		name        string
		h           http.Handler
		method      string
		path        string
		status      int
		body        string
		contentType string
	}{
		{"healthz", h, "GET", "/healthz", 200, "ok\n", "text/plain; charset=utf-8"},
		{"websocket", h, "GET", "/ws", http.StatusTeapot, "", ""},
		{"map", h, "GET", "/maps/office.tmj", 200, `{"type":"map"}`, "application/json"},
		{"missing map", h, "GET", "/maps/nope.tmj", 404, "", ""},
		{"maps dir", h, "GET", "/maps/", 404, "", ""},
		{"maps subdir", h, "GET", "/maps/old/", 404, "", ""},
		{"maps subdir no slash", h, "GET", "/maps/old", 404, "", ""},
		{"web index", h, "GET", "/", 200, "<html>office</html>", "text/html; charset=utf-8"},
		{"web asset", h, "GET", "/assets/app.js", 200, "app", ""},
		{"web subdir", h, "GET", "/assets/", 404, "", ""},
		{"web subdir no slash", h, "GET", "/assets", 404, "", ""},
		{"web subdir with index", h, "GET", "/nested/", 404, "", ""},
		{"web root without index", noIndexWeb, "GET", "/", 404, "", ""},
		{"missing web dir", noWeb, "GET", "/", 404, "", ""},
		{"wrong method", h, "POST", "/healthz", http.StatusMethodNotAllowed, "", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			tt.h.ServeHTTP(rec, httptest.NewRequest(tt.method, tt.path, nil))
			res := rec.Result()
			body, _ := io.ReadAll(res.Body)

			if res.StatusCode != tt.status {
				t.Errorf("status = %d, want %d", res.StatusCode, tt.status)
			}
			if tt.body != "" && string(body) != tt.body {
				t.Errorf("body = %q, want %q", body, tt.body)
			}
			if got := res.Header.Get("Content-Type"); tt.contentType != "" && got != tt.contentType {
				t.Errorf("content type = %q, want %q", got, tt.contentType)
			}
		})
	}
}
