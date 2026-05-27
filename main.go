package main

import (
	"embed"
	"flag"
	"log"
	"net/http"
	"os"
	"path/filepath"
)

//go:embed web/*
var webFS embed.FS

var (
	version = "dev"
	commit  = "none"
	date    = "unknown"
)

func main() {
	port := flag.String("port", "7777", "HTTP port")
	dir := flag.String("dir", defaultProjectsDir(), "Claude projects directory")
	stale := flag.Duration("stale", 0, "Hide exited sessions idle longer than this (0 = show all in 'exited' group)")
	showVersion := flag.Bool("version", false, "Print version and exit")
	flag.Parse()

	if *showVersion {
		log.SetFlags(0)
		log.Printf("claude-sessions %s (commit %s, built %s)", version, commit, date)
		return
	}

	if _, err := os.Stat(*dir); err != nil {
		log.Fatalf("projects dir not found: %s (%v)", *dir, err)
	}

	store, err := NewStore(*dir)
	if err != nil {
		log.Fatal(err)
	}
	defer store.Close()

	log.Printf("scanning %s", *dir)
	if err := store.Start(); err != nil {
		log.Fatal(err)
	}
	log.Printf("found %d sessions", len(store.Snapshot()))

	srv := NewServer(store, webFS, *stale)
	addr := ":" + *port
	log.Printf("claude-sessions listening on http://localhost%s", addr)
	log.Fatal(http.ListenAndServe(addr, srv))
}

func defaultProjectsDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ".claude/projects"
	}
	return filepath.Join(home, ".claude", "projects")
}
