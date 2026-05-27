package main

import (
	"bufio"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
)

// LiveSessionIDs returns the set of session IDs that appear to belong to
// a currently-running `claude` process.
//
// Claude Code does NOT hold its JSONL file open continuously — it opens,
// appends, and closes per message. So we can't use `lsof` on the JSONL
// directly. Instead:
//
//  1. Find all PIDs whose executable name is exactly `claude`.
//  2. For each PID, read its current working directory.
//  3. In the corresponding `~/.claude/projects/<encoded-cwd>/` directory,
//     claim the N most-recently-modified JSONL files (where N = number of
//     claude PIDs in that cwd).
//
// This is a heuristic, not a guarantee — but it correctly attributes the
// vast majority of cases. The alternative (showing every JSONL ever
// created) wildly overcounts.
func LiveSessionIDs(projectsRoot string) map[string]bool {
	out := map[string]bool{}
	if runtime.GOOS == "windows" {
		return out
	}

	pids := findClaudePIDs()
	if len(pids) == 0 {
		return out
	}

	cwdCounts := map[string]int{}
	for _, pid := range pids {
		cwd, err := processCwd(pid)
		if err != nil || cwd == "" {
			continue
		}
		cwdCounts[cwd]++
	}

	for cwd, n := range cwdCounts {
		encoded := encodeProjectDir(cwd)
		dir := filepath.Join(projectsRoot, encoded)
		for _, id := range mostRecentJSONLs(dir, n) {
			out[id] = true
		}
	}
	return out
}

func findClaudePIDs() []int {
	out, err := exec.Command("pgrep", "-x", "claude").Output()
	if err != nil {
		return nil
	}
	var pids []int
	s := bufio.NewScanner(strings.NewReader(string(out)))
	for s.Scan() {
		if pid, err := strconv.Atoi(strings.TrimSpace(s.Text())); err == nil {
			pids = append(pids, pid)
		}
	}
	return pids
}

func processCwd(pid int) (string, error) {
	if runtime.GOOS == "linux" {
		return os.Readlink(fmt.Sprintf("/proc/%d/cwd", pid))
	}
	out, err := exec.Command("lsof", "-a", "-p", strconv.Itoa(pid), "-d", "cwd", "-Fn").Output()
	if err != nil {
		return "", err
	}
	for _, line := range strings.Split(string(out), "\n") {
		if strings.HasPrefix(line, "n") {
			return strings.TrimPrefix(line, "n"), nil
		}
	}
	return "", nil
}

func encodeProjectDir(cwd string) string {
	return strings.ReplaceAll(cwd, "/", "-")
}

func mostRecentJSONLs(dir string, n int) []string {
	if n <= 0 {
		return nil
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	type item struct {
		id    string
		mtime int64
	}
	var items []item
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".jsonl") {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		items = append(items, item{
			id:    strings.TrimSuffix(e.Name(), ".jsonl"),
			mtime: info.ModTime().UnixNano(),
		})
	}
	sort.Slice(items, func(i, j int) bool { return items[i].mtime > items[j].mtime })
	if n > len(items) {
		n = len(items)
	}
	out := make([]string, 0, n)
	for i := 0; i < n; i++ {
		out = append(out, items[i].id)
	}
	return out
}
