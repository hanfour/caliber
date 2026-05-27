// Package cwdresolve resolves the working-directory for a single Claude
// project directory. It is extracted from wizard.ScanClaudeProjects so that
// the watcher loop can reuse the same algorithm without importing the wizard.
package cwdresolve

import (
	"bufio"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// Opener abstracts file access so tests can inject byte-counting wrappers.
type Opener func(path string) (io.ReadCloser, error)

// DefaultOpener wraps os.Open.
func DefaultOpener(p string) (io.ReadCloser, error) {
	return os.Open(p)
}

// perDirByteBudget caps total bytes read across all *.jsonl files in a
// single project directory (spec §4.5).
const perDirByteBudget int64 = 256 * 1024

// ResolveOneClaudeDir returns the working-directory for a single Claude
// project directory. Three-state contract:
//
//	(cwd, nil)  — resolved; cwd is absolute and stats as a directory.
//	("",  nil)  — no I/O error but no usable cwd (exhausted budget + dirname fallback failed).
//	("",  err)  — I/O failure (e.g. could not read the directory).
func ResolveOneClaudeDir(dir string, open Opener) (string, error) {
	jsonls, err := listJSONL(dir)
	if err != nil {
		return "", err
	}

	cwd := scanJSONLForCWD(jsonls, open)
	if cwd == "" {
		cwd = dirnameFallback(filepath.Base(dir))
	}
	if cwd == "" {
		return "", nil
	}
	return cwd, nil
}

// listJSONL returns the *.jsonl files in dir sorted newest-mtime-first.
// It returns an error only for hard I/O failures; a missing dir yields
// (nil, nil).
func listJSONL(dir string) ([]string, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	type entry struct {
		path  string
		mtime int64
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
		es = append(es, entry{path: filepath.Join(dir, e.Name()), mtime: info.ModTime().UnixNano()})
	}
	sort.Slice(es, func(i, j int) bool { return es[i].mtime > es[j].mtime })
	paths := make([]string, len(es))
	for i, e := range es {
		paths[i] = e.path
	}
	return paths, nil
}

// scanJSONLForCWD reads files newest-first, bounded by perDirByteBudget
// total bytes. Returns the first cwd that stats as a directory.
func scanJSONLForCWD(jsonls []string, open Opener) string {
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
// a directory. Empty string otherwise. The candidate is resolved through
// filepath.EvalSymlinks before stat so attacker-supplied symlinks cannot
// be used to escape the allow-list match downstream.
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
	resolved, err := filepath.EvalSymlinks(obj.CWD)
	if err != nil {
		return ""
	}
	info, err := os.Stat(resolved)
	if err != nil || !info.IsDir() {
		return ""
	}
	return resolved
}

// dirnameFallback decodes Claude's dash-encoded project dir name back into
// an absolute path. Claude encodes a project directory by replacing every
// "/" with "-", so the name begins with "-". This decode is ambiguous when
// the original path contained native hyphens; we resolve the ambiguity by
// greedily statting each prefix, preferring to treat a dash as a path
// separator (deeper interpretation) and only treating it as a literal
// hyphen in a component name when the separator interpretation does not
// lead to an existing path on disk.
func dirnameFallback(name string) string {
	if !strings.HasPrefix(name, "-") {
		return ""
	}
	body := name[1:] // strip leading "-"
	result := greedyDecode("/", body)
	if result == "" {
		return ""
	}
	// Resolve symlinks on the candidate so the eventual cwd we hand to
	// the watcher allow-list is canonical. greedyDecode performs
	// intermediate stat checks against the encoded path components; the
	// final EvalSymlinks here is the load-bearing one.
	resolved, err := filepath.EvalSymlinks(result)
	if err != nil {
		return ""
	}
	info, err := os.Stat(resolved)
	if err != nil || !info.IsDir() {
		return ""
	}
	return resolved
}

// greedyDecode attempts to reconstruct an absolute path from a dash-encoded
// string. At each "-" it first tries treating it as a path separator
// (Option A — stats the accumulated prefix and recurses if it exists),
// falling back to treating it as a literal hyphen (Option B).
func greedyDecode(current, remaining string) string {
	if remaining == "" {
		return current
	}
	idx := strings.Index(remaining, "-")
	if idx == -1 {
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
		if r := greedyDecode(base+"/", rest); r != "" {
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
