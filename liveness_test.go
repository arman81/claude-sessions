package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestEncodeProjectDir(t *testing.T) {
	cases := []struct{ in, want string }{
		{"/Users/arman/code/moveworks", "-Users-arman-code-moveworks"},
		{"/Users/arman/razorpay", "-Users-arman-razorpay"},
		{"/", "-"},
	}
	for _, c := range cases {
		got := encodeProjectDir(c.in)
		if got != c.want {
			t.Errorf("encodeProjectDir(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestMostRecentJSONLs(t *testing.T) {
	dir := t.TempDir()

	now := time.Now()
	files := []struct {
		name  string
		mtime time.Time
	}{
		{"old.jsonl", now.Add(-2 * time.Hour)},
		{"newest.jsonl", now},
		{"middle.jsonl", now.Add(-1 * time.Hour)},
		{"not-jsonl.txt", now}, // should be ignored
	}
	for _, f := range files {
		path := filepath.Join(dir, f.name)
		if err := os.WriteFile(path, []byte("x"), 0644); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(path, f.mtime, f.mtime); err != nil {
			t.Fatal(err)
		}
	}

	got := mostRecentJSONLs(dir, 2)
	want := []string{"newest", "middle"}
	if len(got) != len(want) {
		t.Fatalf("got %d files, want %d (%v)", len(got), len(want), got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("got[%d] = %q, want %q", i, got[i], want[i])
		}
	}
}

func TestMostRecentJSONLs_FewerThanRequested(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "only.jsonl"), []byte("x"), 0644)
	got := mostRecentJSONLs(dir, 5)
	if len(got) != 1 {
		t.Errorf("got %d, want 1", len(got))
	}
}

func TestMostRecentJSONLs_ZeroOrNegative(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "a.jsonl"), []byte("x"), 0644)
	if got := mostRecentJSONLs(dir, 0); len(got) != 0 {
		t.Errorf("n=0 returned %d", len(got))
	}
	if got := mostRecentJSONLs(dir, -1); len(got) != 0 {
		t.Errorf("n=-1 returned %d", len(got))
	}
}

func TestMostRecentJSONLs_MissingDir(t *testing.T) {
	got := mostRecentJSONLs("/nonexistent/path/here", 5)
	if got != nil {
		t.Errorf("expected nil for missing dir, got %v", got)
	}
}
