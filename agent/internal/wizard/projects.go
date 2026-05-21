package wizard

import (
	"bufio"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
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

const perDirByteBudget int64 = 256 * 1024

// ScanClaudeProjects walks <root> and returns one ProjectCandidate per
// resolvable Claude project directory. JSONL content is the primary cwd
// source; dirname dash-decode is the fallback. Spec §4.5.
func ScanClaudeProjects(root string) ([]ProjectCandidate, error) {
	return scanClaudeProjects(root, defaultOpener)
}

func defaultOpener(p string) (io.ReadCloser, error) {
	return os.Open(p)
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
		cand, ok := resolveDir(dir, name, open)
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
func resolveDir(dir, name string, open opener) (ProjectCandidate, bool) {
	jsonls, lastSeen := listJSONL(dir)

	cwd := scanJSONLForCWD(jsonls, open)
	if cwd == "" {
		cwd = dirnameFallback(name)
	}
	if cwd == "" {
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

// scanJSONLForCWD reads files newest-first, bounded by perDirByteBudget
// total bytes across all files in the dir. Returns the first cwd that
// stats as a directory.
//
// Memory bound: wrap the file in io.LimitReader sized to the remaining
// per-dir budget. ReadString's worst-case allocation is therefore exactly
// the budget — never more. A 20 MB single-line file truncates to 256 KiB,
// fails JSON parse, falls through to dirname decode (spec §4.5).
func scanJSONLForCWD(jsonls []string, open opener) string {
	budget := perDirByteBudget
	for _, path := range jsonls {
		if budget <= 0 {
			break
		}
		f, err := open(path)
		if err != nil {
			continue
		}
		lr := io.LimitReader(f, budget)
		reader := bufio.NewReaderSize(lr, 64*1024)
		for budget > 0 {
			line, err := reader.ReadString('\n')
			budget -= int64(len(line))
			if len(line) > 0 {
				if cwd := tryExtractCWD(line); cwd != "" {
					_ = f.Close()
					return cwd
				}
			}
			if err == io.EOF {
				break
			}
			if err != nil {
				break
			}
		}
		_ = f.Close()
	}
	return ""
}

// tryExtractCWD parses one JSONL line and returns its cwd if it stats as
// a directory. Empty string otherwise. Tolerates malformed JSON silently.
func tryExtractCWD(line string) string {
	var obj struct {
		CWD string `json:"cwd"`
	}
	if err := json.Unmarshal([]byte(line), &obj); err != nil {
		return ""
	}
	if obj.CWD == "" {
		return ""
	}
	info, err := os.Stat(obj.CWD)
	if err != nil || !info.IsDir() {
		return ""
	}
	return obj.CWD
}

// dirnameFallback decodes Claude's dash-encoded project dir name back into
// an absolute path. Claude encodes a project directory by replacing every
// "/" with "-", so the name begins with "-". This decode is ambiguous when
// the original path contained native hyphens; we resolve the ambiguity by
// greedily statting each prefix, preferring to extend the current path
// component before treating a dash as a separator.
func dirnameFallback(name string) string {
	if !strings.HasPrefix(name, "-") {
		return ""
	}
	// The leading "-" encodes the leading "/" of the absolute path.
	// Everything after is a sequence of path components separated by "-".
	body := name[1:] // strip leading "-"
	result := greedyDecode("/", body)
	if result == "" {
		return ""
	}
	info, err := os.Stat(result)
	if err != nil || !info.IsDir() {
		return ""
	}
	return result
}

// greedyDecode attempts to reconstruct an absolute path from a dash-encoded
// string. It walks the encoded string left-to-right; at each "-" it first
// tries treating the accumulated segment as part of the current directory
// component (i.e., the dash is a literal hyphen), and only falls back to
// treating it as a path separator if that leads to an existing path on disk.
// This is a depth-first search bounded by actual filesystem stat calls.
func greedyDecode(current, remaining string) string {
	if remaining == "" {
		return current
	}
	idx := strings.Index(remaining, "-")
	if idx == -1 {
		// No more dashes; append remaining as final component.
		candidate := current + remaining
		if current == "/" {
			candidate = "/" + remaining
		}
		return candidate
	}

	seg := remaining[:idx]
	rest := remaining[idx+1:]

	var base string
	if current == "/" {
		base = "/" + seg
	} else {
		base = current + seg
	}

	// Option A: the dash is a path separator — try statting base as a dir.
	if info, err := os.Stat(base); err == nil && info.IsDir() {
		// Recurse with base as the current directory.
		if r := greedyDecode(base+"/", rest); r != "" {
			// Verify the final result exists before returning.
			if _, e2 := os.Stat(r); e2 == nil {
				return r
			}
		}
	}

	// Option B: the dash is a literal hyphen in the path component name.
	extended := seg + "-"
	return greedyDecode2(current, extended, rest)
}

// greedyDecode2 continues building the current path component (we're mid-
// component, having seen a hyphen that turned out not to be a separator).
func greedyDecode2(dirSoFar, component, remaining string) string {
	if remaining == "" {
		// component ends here (no trailing separator)
		var candidate string
		if dirSoFar == "/" {
			candidate = "/" + strings.TrimSuffix(component, "-")
		} else {
			candidate = dirSoFar + strings.TrimSuffix(component, "-")
		}
		return candidate
	}
	idx := strings.Index(remaining, "-")
	if idx == -1 {
		// Remaining has no more dashes — append to component.
		component += remaining
		var candidate string
		if dirSoFar == "/" {
			candidate = "/" + component
		} else {
			candidate = dirSoFar + component
		}
		return candidate
	}

	seg := remaining[:idx]
	rest := remaining[idx+1:]
	component += seg

	var base string
	if dirSoFar == "/" {
		base = "/" + component
	} else {
		base = dirSoFar + component
	}

	// Option A: dash is a path separator — stat base.
	if info, err := os.Stat(base); err == nil && info.IsDir() {
		if r := greedyDecode(base+"/", rest); r != "" {
			if _, e2 := os.Stat(r); e2 == nil {
				return r
			}
		}
	}

	// Option B: dash is a literal hyphen — keep building component.
	return greedyDecode2(dirSoFar, component+"-", rest)
}
