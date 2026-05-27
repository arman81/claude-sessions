# claude-sessions

A lightweight local dashboard for tracking every Claude Code session running on your machine — across every terminal, in every directory.

Useful when you have 10+ Claude Code sessions open in parallel and lose track of which terminal is doing what.

[![ci](https://github.com/arman81/claude-sessions/actions/workflows/ci.yml/badge.svg)](https://github.com/arman81/claude-sessions/actions/workflows/ci.yml)
[![release](https://img.shields.io/github/v/release/arman81/claude-sessions?include_prereleases&sort=semver)](https://github.com/arman81/claude-sessions/releases)
[![license](https://img.shields.io/github/license/arman81/claude-sessions)](LICENSE)

## Screenshot

> _Add a screenshot here:_ run `claude-sessions`, open http://localhost:7777, take a screenshot, save it as `docs/screenshot.png`, then replace this block with:
>
> ```markdown
> ![claude-sessions dashboard](docs/screenshot.png)
> ```

## Features

- **Distinguishes live vs exited sessions** — uses `pgrep` + per-PID `cwd` to attribute JSONL files to actually-running `claude` processes (not the dozens of historical files that pile up over time)
- **Collapsible sidebar** grouped by state — Running / Waiting / Thinking / Idle / Exited
- **Summary pane** with metrics, transcript, and copy-to-clipboard `claude --resume <id>`
- **Live updates** via Server-Sent Events — new messages reflect within milliseconds
- **Material Design 3 dark theme**
- **Search** by project, branch, or prompt text
- **Zero impact** on running Claude sessions — read-only file tailing, no hooks, no IPC

## Install

### Homebrew (macOS / Linux)

```bash
brew install arman81/tap/claude-sessions
```

### Go

```bash
go install github.com/arman81/claude-sessions@latest
```

### Pre-built binary

Download for your platform from [Releases](https://github.com/arman81/claude-sessions/releases/latest).

### From source

```bash
git clone https://github.com/arman81/claude-sessions
cd claude-sessions
go build
./claude-sessions
```

## Usage

```bash
claude-sessions
# → open http://localhost:7777
```

## How it works

Every running `claude` instance appends to a JSONL file at `~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl`. The file is *not* deleted on exit, so over time each project directory accumulates many historical JSONLs.

This tool:

1. Scans `~/.claude/projects` at startup and parses each JSONL
2. Subscribes to filesystem events via `fsnotify` (FSEvents on macOS, inotify on Linux, ReadDirectoryChangesW on Windows)
3. Every 5 seconds, runs **liveness detection**: `pgrep -x claude` for PIDs, then per-PID cwd via `lsof` (or `/proc/<pid>/cwd` on Linux). For each `cwd`, the N most-recently-modified JSONLs in that project directory are claimed as live, where N = number of claude PIDs with that cwd.
4. Re-parses each file on change (debounced 150ms) and pushes deltas to the browser over SSE

No hooks, no process attachment, no Claude Code modification. The tool can't slow your sessions down because it never touches them — it only reads files they already write.

### Resource footprint

| | claude-sessions |
|---|---|
| Binary size | ~8 MB (static) |
| Cold start | <1s for ~70 sessions |
| RSS at runtime | ~20 MB |
| CPU (idle) | ~0% |

### State detection

Each session is `live` (has a running `claude` process) or `exited`. Among live sessions, the activity state is derived from the last non-metadata entry in the JSONL plus the file mtime:

| Last entry | mtime age | State |
|---|---|---|
| assistant text only | < 30 min | `waiting_user` |
| assistant with unresolved `tool_use` | < 2 min | `running_tool` |
| user with `tool_result` | < 1 min | `thinking` |
| anything else / older | — | `idle` |

Exited sessions are hidden by default. Toggle **Show exited** in the sidebar to see them.

### Flags

| Flag | Default | Description |
|---|---|---|
| `-port` | `7777` | HTTP port |
| `-dir` | `~/.claude/projects` | Claude projects directory |
| `-stale` | `0` | Hide exited sessions idle longer than this. `0` means keep all (just toggle visibility in the UI). |
| `-version` | — | Print version and exit |

## Development

```bash
# Run tests
go test -v ./...

# Run with race detector
go test -race ./...

# Format
gofmt -w .

# Build
go build
```

### Releasing

Push a semver tag — GitHub Actions handles the rest via GoReleaser:

```bash
git tag v0.1.0
git push origin v0.1.0
```

To enable the Homebrew tap, create a `homebrew-tap` repo under your account and add a `HOMEBREW_TAP_GITHUB_TOKEN` secret in this repo's settings with `repo` scope on the tap.

## Contributing

Issues and PRs welcome. Keep the dependency surface minimal — the only runtime dep is `fsnotify`, and the frontend is intentionally build-step-free vanilla JS.

## License

MIT — see [LICENSE](LICENSE).
