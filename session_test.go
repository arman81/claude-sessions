package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func writeJSONL(t *testing.T, dir, name string, entries []map[string]any) string {
	t.Helper()
	path := filepath.Join(dir, name)
	f, err := os.Create(path)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	defer f.Close()
	for _, e := range entries {
		b, err := json.Marshal(e)
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}
		if _, err := f.Write(append(b, '\n')); err != nil {
			t.Fatalf("write: %v", err)
		}
	}
	return path
}

func userMsg(content any) map[string]any {
	return map[string]any{
		"type":      "user",
		"timestamp": "2026-05-27T07:00:00.000Z",
		"cwd":       "/Users/test/repo",
		"gitBranch": "main",
		"version":   "2.1.0",
		"message":   map[string]any{"role": "user", "content": content},
	}
}

func assistantMsg(content any) map[string]any {
	return map[string]any{
		"type":      "assistant",
		"timestamp": "2026-05-27T07:00:01.000Z",
		"message":   map[string]any{"role": "assistant", "content": content},
	}
}

func TestParseSession_WaitingUser(t *testing.T) {
	dir := t.TempDir()
	path := writeJSONL(t, dir, "abc.jsonl", []map[string]any{
		userMsg("hello"),
		assistantMsg([]map[string]any{{"type": "text", "text": "hi there"}}),
	})

	s, err := ParseSession(path)
	if err != nil {
		t.Fatal(err)
	}
	if s.State != StateWaitingUser {
		t.Errorf("state = %q, want %q", s.State, StateWaitingUser)
	}
	if s.MessageCount != 2 {
		t.Errorf("messageCount = %d, want 2", s.MessageCount)
	}
	if s.FirstUserMessage != "hello" {
		t.Errorf("firstUserMessage = %q, want %q", s.FirstUserMessage, "hello")
	}
	if s.LastAssistantText != "hi there" {
		t.Errorf("lastAssistantText = %q, want %q", s.LastAssistantText, "hi there")
	}
}

func TestParseSession_RunningTool(t *testing.T) {
	dir := t.TempDir()
	path := writeJSONL(t, dir, "abc.jsonl", []map[string]any{
		userMsg("run a command"),
		assistantMsg([]map[string]any{
			{"type": "text", "text": "running..."},
			{"type": "tool_use", "name": "Bash", "id": "tool_1"},
		}),
	})

	s, err := ParseSession(path)
	if err != nil {
		t.Fatal(err)
	}
	if s.State != StateRunningTool {
		t.Errorf("state = %q, want %q", s.State, StateRunningTool)
	}
	if s.LastToolName != "Bash" {
		t.Errorf("lastToolName = %q, want %q", s.LastToolName, "Bash")
	}
}

func TestParseSession_Thinking(t *testing.T) {
	dir := t.TempDir()
	path := writeJSONL(t, dir, "abc.jsonl", []map[string]any{
		userMsg("do thing"),
		assistantMsg([]map[string]any{{"type": "tool_use", "name": "Read", "id": "t1"}}),
		userMsg([]map[string]any{{"type": "tool_result", "tool_use_id": "t1", "content": "ok"}}),
	})

	s, err := ParseSession(path)
	if err != nil {
		t.Fatal(err)
	}
	if s.State != StateThinking {
		t.Errorf("state = %q, want %q", s.State, StateThinking)
	}
}

func TestParseSession_IdleFromStaleAssistant(t *testing.T) {
	dir := t.TempDir()
	path := writeJSONL(t, dir, "abc.jsonl", []map[string]any{
		userMsg("hi"),
		assistantMsg([]map[string]any{{"type": "text", "text": "yo"}}),
	})

	stale := time.Now().Add(-2 * time.Hour)
	if err := os.Chtimes(path, stale, stale); err != nil {
		t.Fatal(err)
	}

	s, err := ParseSession(path)
	if err != nil {
		t.Fatal(err)
	}
	if s.State != StateIdle {
		t.Errorf("state = %q, want %q (with mtime 2h ago)", s.State, StateIdle)
	}
}

func TestParseSession_StringContent(t *testing.T) {
	dir := t.TempDir()
	path := writeJSONL(t, dir, "abc.jsonl", []map[string]any{
		userMsg("plain string content"),
		assistantMsg("plain string reply"),
	})

	s, err := ParseSession(path)
	if err != nil {
		t.Fatal(err)
	}
	if s.FirstUserMessage != "plain string content" {
		t.Errorf("first user = %q", s.FirstUserMessage)
	}
	if s.LastAssistantText != "plain string reply" {
		t.Errorf("last asst = %q", s.LastAssistantText)
	}
}

func TestParseSession_MetadataExtraction(t *testing.T) {
	dir := t.TempDir()
	path := writeJSONL(t, dir, "abc.jsonl", []map[string]any{
		{"type": "permission-mode", "permissionMode": "acceptEdits"},
		{"type": "file-history-snapshot", "messageId": "x"},
		userMsg("first"),
		userMsg("second"),
	})

	s, err := ParseSession(path)
	if err != nil {
		t.Fatal(err)
	}
	if s.PermissionMode != "acceptEdits" {
		t.Errorf("permissionMode = %q", s.PermissionMode)
	}
	if s.GitBranch != "main" {
		t.Errorf("gitBranch = %q", s.GitBranch)
	}
	if s.Version != "2.1.0" {
		t.Errorf("version = %q", s.Version)
	}
	if s.CWD != "/Users/test/repo" {
		t.Errorf("cwd = %q", s.CWD)
	}
	if s.Project != "repo" {
		t.Errorf("project = %q", s.Project)
	}
	if s.UserMessageCount != 2 {
		t.Errorf("userMessageCount = %d, want 2", s.UserMessageCount)
	}
	if s.FirstUserMessage != "first" {
		t.Errorf("firstUserMessage = %q", s.FirstUserMessage)
	}
	if s.LastUserMessage != "second" {
		t.Errorf("lastUserMessage = %q", s.LastUserMessage)
	}
}

func TestParseSession_SkipsMetaForState(t *testing.T) {
	// trailing meta entries (permission-mode, file-history-snapshot, last-prompt)
	// shouldn't flip the state away from the actual last message.
	dir := t.TempDir()
	path := writeJSONL(t, dir, "abc.jsonl", []map[string]any{
		userMsg("hi"),
		assistantMsg([]map[string]any{{"type": "text", "text": "yo"}}),
		{"type": "last-prompt", "lastPrompt": "noise"},
		{"type": "permission-mode", "permissionMode": "acceptEdits"},
	})

	s, err := ParseSession(path)
	if err != nil {
		t.Fatal(err)
	}
	if s.State != StateWaitingUser {
		t.Errorf("state = %q, want %q (meta entries should be ignored)", s.State, StateWaitingUser)
	}
}

func TestParseSession_MalformedLineSkipped(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "abc.jsonl")
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	f.WriteString("not json at all\n")
	b, _ := json.Marshal(userMsg("real message"))
	f.Write(append(b, '\n'))
	f.Close()

	s, err := ParseSession(path)
	if err != nil {
		t.Fatal(err)
	}
	if s.FirstUserMessage != "real message" {
		t.Errorf("expected real message to be parsed, got %q", s.FirstUserMessage)
	}
}

func TestParseSession_EmptyFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "abc.jsonl")
	if err := os.WriteFile(path, []byte{}, 0644); err != nil {
		t.Fatal(err)
	}

	s, err := ParseSession(path)
	if err != nil {
		t.Fatal(err)
	}
	if s.MessageCount != 0 {
		t.Errorf("expected 0 messages, got %d", s.MessageCount)
	}
	if s.State != StateIdle {
		t.Errorf("empty file should be idle, got %q", s.State)
	}
}

func TestDecodeProjectDir(t *testing.T) {
	cases := []struct{ in, want string }{
		{"-Users-arman-code-moveworks", "/Users/arman/code/moveworks"},
		{"plainname", "plainname"},
		{"-tmp", "/tmp"},
	}
	for _, c := range cases {
		got := decodeProjectDir(c.in)
		if got != c.want {
			t.Errorf("decodeProjectDir(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestTruncate(t *testing.T) {
	cases := []struct {
		in   string
		n    int
		want string
	}{
		{"short", 10, "short"},
		{"exactlyten", 10, "exactlyten"},
		{"this is longer than ten chars", 10, "this is lo…"},
	}
	for _, c := range cases {
		got := truncate(c.in, c.n)
		if got != c.want {
			t.Errorf("truncate(%q,%d) = %q, want %q", c.in, c.n, got, c.want)
		}
	}
}
