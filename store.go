package main

import (
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
)

type StoreEvent struct {
	Kind    string   `json:"kind"` // "upsert" | "delete" | "snapshot"
	Session *Session `json:"session,omitempty"`
	ID      string   `json:"id,omitempty"`
}

type Store struct {
	root     string
	sessions map[string]*Session
	mu       sync.RWMutex

	watcher *fsnotify.Watcher

	subs   map[chan StoreEvent]struct{}
	subsMu sync.Mutex

	debounce   map[string]*time.Timer
	debounceMu sync.Mutex

	live   map[string]bool
	liveMu sync.RWMutex

	livenessInterval time.Duration
	stop             chan struct{}
}

func NewStore(root string) (*Store, error) {
	w, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, err
	}
	return &Store{
		root:             root,
		sessions:         make(map[string]*Session),
		watcher:          w,
		subs:             make(map[chan StoreEvent]struct{}),
		debounce:         make(map[string]*time.Timer),
		live:             make(map[string]bool),
		livenessInterval: 5 * time.Second,
		stop:             make(chan struct{}),
	}, nil
}

func (s *Store) Close() error {
	close(s.stop)
	return s.watcher.Close()
}

func (s *Store) Start() error {
	if err := s.scanAll(); err != nil {
		return err
	}
	s.refreshLiveness(false)
	s.applyLivenessAll()
	if err := s.addWatches(); err != nil {
		return err
	}
	go s.loop()
	go s.livenessLoop()
	return nil
}

func (s *Store) scanAll() error {
	entries, err := os.ReadDir(s.root)
	if err != nil {
		return err
	}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		projDir := filepath.Join(s.root, e.Name())
		files, err := os.ReadDir(projDir)
		if err != nil {
			continue
		}
		for _, f := range files {
			if !strings.HasSuffix(f.Name(), ".jsonl") {
				continue
			}
			path := filepath.Join(projDir, f.Name())
			if sess, err := ParseSession(path); err == nil {
				s.mu.Lock()
				s.sessions[sess.ID] = sess
				s.mu.Unlock()
			} else {
				log.Printf("parse %s: %v", path, err)
			}
		}
	}
	return nil
}

func (s *Store) addWatches() error {
	if err := s.watcher.Add(s.root); err != nil {
		return err
	}
	entries, err := os.ReadDir(s.root)
	if err != nil {
		return err
	}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		if err := s.watcher.Add(filepath.Join(s.root, e.Name())); err != nil {
			log.Printf("watch %s: %v", e.Name(), err)
		}
	}
	return nil
}

func (s *Store) loop() {
	for {
		select {
		case ev, ok := <-s.watcher.Events:
			if !ok {
				return
			}
			s.handleEvent(ev)
		case err, ok := <-s.watcher.Errors:
			if !ok {
				return
			}
			log.Printf("watcher: %v", err)
		}
	}
}

func (s *Store) handleEvent(ev fsnotify.Event) {
	if ev.Op&fsnotify.Create != 0 {
		if info, err := os.Stat(ev.Name); err == nil && info.IsDir() {
			_ = s.watcher.Add(ev.Name)
			return
		}
	}
	if !strings.HasSuffix(ev.Name, ".jsonl") {
		return
	}
	if ev.Op&(fsnotify.Remove|fsnotify.Rename) != 0 {
		id := strings.TrimSuffix(filepath.Base(ev.Name), ".jsonl")
		s.mu.Lock()
		delete(s.sessions, id)
		s.mu.Unlock()
		s.broadcast(StoreEvent{Kind: "delete", ID: id})
		return
	}
	if ev.Op&(fsnotify.Write|fsnotify.Create) != 0 {
		s.debounceReparse(ev.Name)
	}
}

func (s *Store) debounceReparse(path string) {
	s.debounceMu.Lock()
	defer s.debounceMu.Unlock()
	if t, ok := s.debounce[path]; ok {
		t.Stop()
	}
	s.debounce[path] = time.AfterFunc(150*time.Millisecond, func() {
		s.debounceMu.Lock()
		delete(s.debounce, path)
		s.debounceMu.Unlock()

		sess, err := ParseSession(path)
		if err != nil {
			return
		}
		s.liveMu.RLock()
		sess.Live = s.live[sess.ID]
		s.liveMu.RUnlock()

		s.mu.Lock()
		s.sessions[sess.ID] = sess
		s.mu.Unlock()
		s.broadcast(StoreEvent{Kind: "upsert", Session: sess})
	})
}

func (s *Store) livenessLoop() {
	t := time.NewTicker(s.livenessInterval)
	defer t.Stop()
	for {
		select {
		case <-s.stop:
			return
		case <-t.C:
			s.refreshLiveness(true)
		}
	}
}

// refreshLiveness recomputes the live set. If broadcast is true, emits an
// upsert for every session whose live-status changed.
func (s *Store) refreshLiveness(broadcast bool) {
	next := LiveSessionIDs(s.root)

	s.liveMu.Lock()
	prev := s.live
	s.live = next
	s.liveMu.Unlock()

	if !broadcast {
		return
	}

	changed := map[string]struct{}{}
	for id := range prev {
		if !next[id] {
			changed[id] = struct{}{}
		}
	}
	for id := range next {
		if !prev[id] {
			changed[id] = struct{}{}
		}
	}
	if len(changed) == 0 {
		return
	}

	updates := make([]*Session, 0, len(changed))
	s.mu.Lock()
	for id := range changed {
		if sess, ok := s.sessions[id]; ok {
			sess.Live = next[id]
			updates = append(updates, sess)
		}
	}
	s.mu.Unlock()

	for _, sess := range updates {
		s.broadcast(StoreEvent{Kind: "upsert", Session: sess})
	}
}

func (s *Store) applyLivenessAll() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.liveMu.RLock()
	defer s.liveMu.RUnlock()
	for id, sess := range s.sessions {
		sess.Live = s.live[id]
	}
}

func (s *Store) Snapshot() []*Session {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]*Session, 0, len(s.sessions))
	for _, sess := range s.sessions {
		out = append(out, sess)
	}
	return out
}

func (s *Store) Get(id string) *Session {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.sessions[id]
}

func (s *Store) Subscribe() chan StoreEvent {
	ch := make(chan StoreEvent, 64)
	s.subsMu.Lock()
	s.subs[ch] = struct{}{}
	s.subsMu.Unlock()
	return ch
}

func (s *Store) Unsubscribe(ch chan StoreEvent) {
	s.subsMu.Lock()
	defer s.subsMu.Unlock()
	if _, ok := s.subs[ch]; ok {
		delete(s.subs, ch)
		close(ch)
	}
}

func (s *Store) broadcast(ev StoreEvent) {
	s.subsMu.Lock()
	defer s.subsMu.Unlock()
	for ch := range s.subs {
		select {
		case ch <- ev:
		default:
		}
	}
}
