# claude-sessions

A lightweight local dashboard for tracking every Claude Code session running on your machine — in any terminal, in any directory.

Useful when you have 10+ Claude Code sessions open in parallel and lose track of which terminal is running what.

![status](https://img.shields.io/badge/status-alpha-orange) ![license](https://img.shields.io/badge/license-MIT-blue)

## What it does

- Discovers every Claude Code session on your machine by reading `~/.claude/projects/**/*.jsonl`
- Shows them as cards: project, git branch, last prompt, state, message count, last activity
- Live-updates via SSE — new messages reflect in the UI within milliseconds
- Filter by state (waiting / running / idle) and search by project or prompt
- Zero impact on running Claude sessions (read-only file tailing, no hooks, no IPC)

## Install

```bash
go install github.com/armanjain/claude-sessions@latest
```

Or build from source:

```bash
git clone https://github.com/armanjain/claude-sessions
cd claude-sessions
go build
```

## Run

```bash
claude-sessions
# → open http://localhost:7777
```

Flags:

- `-port 7777` — HTTP port
- `-dir ~/.claude/projects` — override projects directory
- `-stale 24h` — hide sessions idle longer than this

## How it works

Every running `claude` instance appends to a JSONL file under `~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl`. This tool:

1. Scans that directory on startup
2. Subscribes to `fsnotify` events (FSEvents on macOS, inotify on Linux)
3. Streams the JSONL files and parses each entry to build a session summary
4. Pushes updates to the browser over Server-Sent Events

No hooks, no process attachment, no Claude Code modification. The tool can't slow your sessions down because it never touches them — it only reads files they already write.

## License

MIT
