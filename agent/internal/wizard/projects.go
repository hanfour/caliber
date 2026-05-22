package wizard

import (
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/hanfour/ai-dev-eval/agent/internal/cwdresolve"
)

type ProjectCandidate struct {
	CWD       string    // absolute, stat-verified directory
	LastSeen  time.Time // max mtime of *.jsonl, or dir mtime when SessionCt == 0
	SessionCt int       // count of *.jsonl files under this candidate
}

// opener is the file-open seam used by the scanner. Production passes
// os.Open; tests inject byte-counting wrappers. Returns io.ReadCloser so
// callers can wrap freely without changing the contract.
type opener func(path string) (io.ReadCloser, error)

// ScanClaudeProjects walks <root> and returns one ProjectCandidate per
// resolvable Claude project directory. JSONL content is the primary cwd
// source; dirname dash-decode is the fallback. Spec §4.5.
func ScanClaudeProjects(root string) ([]ProjectCandidate, error) {
	return scanClaudeProjects(root, cwdresolve.DefaultOpener)
}

func scanClaudeProjects(root string, open opener) ([]ProjectCandidate, error) {
	entries, err := os.ReadDir(root)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	out := []ProjectCandidate{}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		name := e.Name()
		if !strings.HasPrefix(name, "-") {
			continue
		}
		dir := filepath.Join(root, name)
		cand, ok := resolveDir(dir, open)
		if !ok {
			continue
		}
		out = append(out, cand)
	}
	// Dedupe by CWD, keep newest LastSeen.
	dedup := map[string]ProjectCandidate{}
	for _, c := range out {
		if existing, ok := dedup[c.CWD]; !ok || c.LastSeen.After(existing.LastSeen) {
			dedup[c.CWD] = c
		}
	}
	result := make([]ProjectCandidate, 0, len(dedup))
	for _, c := range dedup {
		result = append(result, c)
	}
	sort.Slice(result, func(i, j int) bool {
		return result[i].LastSeen.After(result[j].LastSeen)
	})
	return result, nil
}

// resolveDir attempts to find the cwd for a single claude project directory.
// Returns (candidate, true) on success, zero-value + false otherwise.
func resolveDir(dir string, open opener) (ProjectCandidate, bool) {
	jsonls, lastSeen := listJSONL(dir)

	cwd, err := cwdresolve.ResolveOneClaudeDir(dir, cwdresolve.Opener(open))
	if err != nil || cwd == "" {
		return ProjectCandidate{}, false
	}

	if len(jsonls) == 0 {
		info, err := os.Stat(dir)
		if err != nil {
			return ProjectCandidate{}, false
		}
		lastSeen = info.ModTime()
	}
	return ProjectCandidate{CWD: cwd, LastSeen: lastSeen, SessionCt: len(jsonls)}, true
}

// listJSONL returns the *.jsonl files in dir sorted newest-mtime-first and
// the latest mtime observed.
func listJSONL(dir string) ([]string, time.Time) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, time.Time{}
	}
	type entry struct {
		path  string
		mtime time.Time
	}
	var es []entry
	for _, e := range entries {
		if e.IsDir() || filepath.Ext(e.Name()) != ".jsonl" {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		es = append(es, entry{path: filepath.Join(dir, e.Name()), mtime: info.ModTime()})
	}
	sort.Slice(es, func(i, j int) bool { return es[i].mtime.After(es[j].mtime) })

	paths := make([]string, len(es))
	var newest time.Time
	for i, e := range es {
		paths[i] = e.path
		if e.mtime.After(newest) {
			newest = e.mtime
		}
	}
	return paths, newest
}
