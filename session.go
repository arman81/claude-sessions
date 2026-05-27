package main

import (
	"bufio"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type SessionState string

const (
	StateWaitingUser SessionState = "waiting_user"
	StateRunningTool SessionState = "running_tool"
	StateThinking    SessionState = "thinking"
	StateIdle        SessionState = "idle"
)

type Session struct {
	ID                string       `json:"id"`
	FilePath          string       `json:"-"`
	CWD               string       `json:"cwd"`
	Project           string       `json:"project"`
	GitBranch         string       `json:"gitBranch"`
	Version           string       `json:"version"`
	StartedAt         time.Time    `json:"startedAt"`
	LastActivity      time.Time    `json:"lastActivity"`
	State             SessionState `json:"state"`
	MessageCount      int          `json:"messageCount"`
	UserMessageCount  int          `json:"userMessageCount"`
	FirstUserMessage  string       `json:"firstUserMessage"`
	LastUserMessage   string       `json:"lastUserMessage"`
	LastAssistantText string       `json:"lastAssistantText"`
	LastToolName      string       `json:"lastToolName"`
	PermissionMode    string       `json:"permissionMode"`
	SizeBytes         int64        `json:"sizeBytes"`
}

type rawEntry struct {
	Type           string          `json:"type"`
	SessionID      string          `json:"sessionId"`
	UUID           string          `json:"uuid"`
	Timestamp      string          `json:"timestamp"`
	CWD            string          `json:"cwd"`
	GitBranch      string          `json:"gitBranch"`
	Version        string          `json:"version"`
	PermissionMode string          `json:"permissionMode"`
	LastPrompt     string          `json:"lastPrompt"`
	Message        json.RawMessage `json:"message"`
}

type rawMessage struct {
	Role    string          `json:"role"`
	Content json.RawMessage `json:"content"`
}

type contentBlock struct {
	Type      string          `json:"type"`
	Text      string          `json:"text"`
	Name      string          `json:"name"`
	ToolUseID string          `json:"tool_use_id"`
	Content   json.RawMessage `json:"content"`
}

const maxLineSize = 32 * 1024 * 1024 // 32MB — tool results can be huge

func ParseSession(path string) (*Session, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	stat, err := f.Stat()
	if err != nil {
		return nil, err
	}

	s := &Session{
		ID:           strings.TrimSuffix(filepath.Base(path), ".jsonl"),
		FilePath:     path,
		LastActivity: stat.ModTime(),
		SizeBytes:    stat.Size(),
	}

	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 64*1024), maxLineSize)

	var lastUserHadToolResult bool
	var lastAssistantHadUnresolvedTool bool
	var lastNonMetaType string

	for scanner.Scan() {
		var e rawEntry
		if err := json.Unmarshal(scanner.Bytes(), &e); err != nil {
			continue
		}

		switch e.Type {
		case "permission-mode":
			if e.PermissionMode != "" {
				s.PermissionMode = e.PermissionMode
			}
			continue
		case "file-history-snapshot":
			continue
		case "last-prompt":
			continue
		case "summary":
			continue
		}

		if e.CWD != "" && s.CWD == "" {
			s.CWD = e.CWD
		}
		if e.GitBranch != "" {
			s.GitBranch = e.GitBranch
		}
		if e.Version != "" {
			s.Version = e.Version
		}
		if ts, err := time.Parse(time.RFC3339Nano, e.Timestamp); err == nil {
			if s.StartedAt.IsZero() || ts.Before(s.StartedAt) {
				s.StartedAt = ts
			}
		}

		switch e.Type {
		case "user":
			s.MessageCount++
			text, hadToolResult := extractUserText(e.Message)
			lastUserHadToolResult = hadToolResult
			if text != "" {
				s.UserMessageCount++
				if s.FirstUserMessage == "" {
					s.FirstUserMessage = text
				}
				s.LastUserMessage = text
			}
			lastNonMetaType = "user"
		case "assistant":
			s.MessageCount++
			text, toolName, hasUnresolved := extractAssistantContent(e.Message)
			lastAssistantHadUnresolvedTool = hasUnresolved
			if text != "" {
				s.LastAssistantText = text
			}
			if toolName != "" {
				s.LastToolName = toolName
			}
			lastNonMetaType = "assistant"
		}
	}

	if err := scanner.Err(); err != nil && err != io.EOF {
		// don't fail the session — partial parse is useful
	}

	s.Project = filepath.Base(s.CWD)
	if s.Project == "" || s.Project == "." {
		s.Project = decodeProjectDir(filepath.Base(filepath.Dir(path)))
	}

	s.State = detectState(s.LastActivity, lastNonMetaType, lastUserHadToolResult, lastAssistantHadUnresolvedTool)

	return s, nil
}

func extractUserText(raw json.RawMessage) (text string, hadToolResult bool) {
	if len(raw) == 0 {
		return "", false
	}
	var msg rawMessage
	if err := json.Unmarshal(raw, &msg); err != nil {
		return "", false
	}

	var asString string
	if err := json.Unmarshal(msg.Content, &asString); err == nil {
		return strings.TrimSpace(asString), false
	}

	var blocks []contentBlock
	if err := json.Unmarshal(msg.Content, &blocks); err != nil {
		return "", false
	}
	var parts []string
	for _, b := range blocks {
		switch b.Type {
		case "text":
			if t := strings.TrimSpace(b.Text); t != "" {
				parts = append(parts, t)
			}
		case "tool_result":
			hadToolResult = true
		}
	}
	return strings.TrimSpace(strings.Join(parts, " ")), hadToolResult
}

func extractAssistantContent(raw json.RawMessage) (text, toolName string, hasUnresolved bool) {
	if len(raw) == 0 {
		return
	}
	var msg rawMessage
	if err := json.Unmarshal(raw, &msg); err != nil {
		return
	}
	var blocks []contentBlock
	if err := json.Unmarshal(msg.Content, &blocks); err != nil {
		var asString string
		if err := json.Unmarshal(msg.Content, &asString); err == nil {
			return strings.TrimSpace(asString), "", false
		}
		return
	}
	var textParts []string
	for _, b := range blocks {
		switch b.Type {
		case "text":
			if t := strings.TrimSpace(b.Text); t != "" {
				textParts = append(textParts, t)
			}
		case "tool_use":
			toolName = b.Name
			hasUnresolved = true
		}
	}
	text = strings.TrimSpace(strings.Join(textParts, " "))
	return
}

func detectState(mtime time.Time, lastType string, userHadToolResult, assistantHasUnresolved bool) SessionState {
	age := time.Since(mtime)

	if lastType == "assistant" && assistantHasUnresolved {
		if age < 2*time.Minute {
			return StateRunningTool
		}
		return StateIdle
	}
	if lastType == "user" && userHadToolResult {
		if age < 1*time.Minute {
			return StateThinking
		}
		return StateIdle
	}
	if lastType == "assistant" {
		if age < 30*time.Minute {
			return StateWaitingUser
		}
		return StateIdle
	}
	return StateIdle
}

func decodeProjectDir(name string) string {
	// dirs are like "-Users-arman-code-moveworks"
	if strings.HasPrefix(name, "-") {
		return strings.ReplaceAll(name, "-", "/")
	}
	return name
}

func truncate(s string, n int) string {
	s = strings.TrimSpace(s)
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
