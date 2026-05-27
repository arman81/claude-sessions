package main

import (
	"bufio"
	"embed"
	"encoding/json"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"sort"
	"strings"
	"time"
)

type Server struct {
	store   *Store
	mux     *http.ServeMux
	maxIdle time.Duration
}

func NewServer(store *Store, webFS embed.FS, maxIdle time.Duration) *Server {
	s := &Server{store: store, mux: http.NewServeMux(), maxIdle: maxIdle}

	sub, err := fs.Sub(webFS, "web")
	if err == nil {
		s.mux.Handle("/", http.FileServer(http.FS(sub)))
	}

	s.mux.HandleFunc("/api/sessions", s.handleList)
	s.mux.HandleFunc("/api/sessions/", s.handleDetail)
	s.mux.HandleFunc("/api/events", s.handleEvents)
	return s
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.mux.ServeHTTP(w, r)
}

func (s *Server) handleList(w http.ResponseWriter, r *http.Request) {
	sessions := s.store.Snapshot()
	sessions = s.filterStale(sessions)
	sort.Slice(sessions, func(i, j int) bool {
		return sessions[i].LastActivity.After(sessions[j].LastActivity)
	})
	writeJSON(w, sessions)
}

func (s *Server) filterStale(in []*Session) []*Session {
	if s.maxIdle <= 0 {
		return in
	}
	cutoff := time.Now().Add(-s.maxIdle)
	out := make([]*Session, 0, len(in))
	for _, sess := range in {
		if sess.Live || sess.LastActivity.After(cutoff) {
			out = append(out, sess)
		}
	}
	return out
}

func (s *Server) handleDetail(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimPrefix(r.URL.Path, "/api/sessions/")
	if strings.HasSuffix(id, "/transcript") {
		s.handleTranscript(w, r, strings.TrimSuffix(id, "/transcript"))
		return
	}
	sess := s.store.Get(id)
	if sess == nil {
		http.NotFound(w, r)
		return
	}
	writeJSON(w, sess)
}

type transcriptTurn struct {
	Role      string    `json:"role"`
	Text      string    `json:"text"`
	ToolName  string    `json:"toolName,omitempty"`
	Timestamp time.Time `json:"timestamp"`
}

func (s *Server) handleTranscript(w http.ResponseWriter, r *http.Request, id string) {
	sess := s.store.Get(id)
	if sess == nil {
		http.NotFound(w, r)
		return
	}
	f, err := os.Open(sess.FilePath)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 64*1024), maxLineSize)

	var turns []transcriptTurn
	for scanner.Scan() {
		var e rawEntry
		if err := json.Unmarshal(scanner.Bytes(), &e); err != nil {
			continue
		}
		ts, _ := time.Parse(time.RFC3339Nano, e.Timestamp)
		switch e.Type {
		case "user":
			text, _ := extractUserText(e.Message)
			if text != "" {
				turns = append(turns, transcriptTurn{Role: "user", Text: text, Timestamp: ts})
			}
		case "assistant":
			text, toolName, _ := extractAssistantContent(e.Message)
			if text != "" || toolName != "" {
				turns = append(turns, transcriptTurn{Role: "assistant", Text: text, ToolName: toolName, Timestamp: ts})
			}
		}
	}
	writeJSON(w, turns)
}

func (s *Server) handleEvents(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", 500)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")

	// initial snapshot
	for _, sess := range s.filterStale(s.store.Snapshot()) {
		sendSSE(w, "upsert", sess)
	}
	sendSSE(w, "snapshot-done", nil)
	flusher.Flush()

	ch := s.store.Subscribe()
	defer s.store.Unsubscribe(ch)

	keepalive := time.NewTicker(20 * time.Second)
	defer keepalive.Stop()

	ctx := r.Context()
	for {
		select {
		case <-ctx.Done():
			return
		case ev, ok := <-ch:
			if !ok {
				return
			}
			switch ev.Kind {
			case "upsert":
				sendSSE(w, "upsert", ev.Session)
			case "delete":
				sendSSE(w, "delete", map[string]string{"id": ev.ID})
			}
			flusher.Flush()
		case <-keepalive.C:
			fmt.Fprint(w, ": ping\n\n")
			flusher.Flush()
		}
	}
}

func sendSSE(w http.ResponseWriter, event string, data any) {
	fmt.Fprintf(w, "event: %s\n", event)
	if data == nil {
		fmt.Fprint(w, "data: {}\n\n")
		return
	}
	b, _ := json.Marshal(data)
	fmt.Fprintf(w, "data: %s\n\n", b)
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}
