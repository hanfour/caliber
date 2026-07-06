package watcher

import (
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

const codexFirstLineCap = 64 * 1024

// CodexSource walks ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl and
// populates FileRef.CWD by reading the first JSONL line as session_meta.
// Opener is injectable so tests can wrap the file with a byte counter.
type CodexSource struct {
	Root string
	open func(path string) (io.ReadCloser, error)
}

// NewCodexSource constructs a CodexSource. If openFn is nil, defaults
// to wrapping os.Open in an io.ReadCloser.
func NewCodexSource(root string, openFn func(path string) (io.ReadCloser, error)) *CodexSource {
	if openFn == nil {
		openFn = func(p string) (io.ReadCloser, error) {
			f, err := os.Open(p)
			if err != nil {
				return nil, err
			}
			return f, nil
		}
	}
	return &CodexSource{Root: root, open: openFn}
}

func (s *CodexSource) Name() string { return "codex" }

var (
	yearRE = regexp.MustCompile(`^[0-9]{4}$`)
	mmddRE = regexp.MustCompile(`^[0-9]{2}$`)
	// uuidSuffix matches the trailing UUID (8-4-4-4-12 hex chars + hyphens = 36 chars)
	// that Codex appends to rollout filenames.
	uuidSuffixRE = regexp.MustCompile(`([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$`)
)

func (s *CodexSource) List(ctx context.Context) ([]FileRef, error) {
	yearEntries, err := os.ReadDir(s.Root)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var refs []FileRef
	for _, ye := range yearEntries {
		if !ye.IsDir() || !yearRE.MatchString(ye.Name()) {
			continue
		}
		yearDir := filepath.Join(s.Root, ye.Name())
		monthEntries, err := os.ReadDir(yearDir)
		if err != nil {
			continue
		}
		for _, me := range monthEntries {
			if !me.IsDir() || !mmddRE.MatchString(me.Name()) {
				continue
			}
			monthDir := filepath.Join(yearDir, me.Name())
			dayEntries, err := os.ReadDir(monthDir)
			if err != nil {
				continue
			}
			for _, de := range dayEntries {
				if !de.IsDir() || !mmddRE.MatchString(de.Name()) {
					continue
				}
				dayDir := filepath.Join(monthDir, de.Name())
				fileEntries, err := os.ReadDir(dayDir)
				if err != nil {
					continue
				}
				for _, fe := range fileEntries {
					if fe.IsDir() || filepath.Ext(fe.Name()) != ".jsonl" {
						continue
					}
					if !strings.HasPrefix(fe.Name(), "rollout-") {
						continue
					}
					// Symlink guard: reject any rollout-*.jsonl that is not
					// a regular file. Without this, an attacker who can
					// write inside ~/.codex/sessions/ could symlink a
					// rollout to /etc/passwd and trigger an unintended read.
					info, lerr := os.Lstat(filepath.Join(dayDir, fe.Name()))
					if lerr != nil || info.Mode()&os.ModeSymlink != 0 {
						continue
					}
					m := uuidSuffixRE.FindStringSubmatch(fe.Name())
					var sessID string
					if len(m) == 2 {
						sessID = m[1]
					}
					path := filepath.Join(dayDir, fe.Name())
					refs = append(refs, FileRef{
						Path:      path,
						Source:    "codex",
						SessionID: sessID,
						CWD:       s.readCWD(path),
						ModTime:   info.ModTime(),
					})
				}
			}
		}
	}
	return refs, nil
}

// readCWD opens the file via the injectable opener, reads up to 64 KiB,
// parses as session_meta JSON, and returns payload.cwd. On any error
// (missing field, malformed, oversize), returns "". Symlinks are
// rejected up front so attacker-supplied targets cannot bypass the
// allow-list check upstream.
func (s *CodexSource) readCWD(path string) string {
	info, err := os.Lstat(path)
	if err != nil || info.Mode()&os.ModeSymlink != 0 {
		return ""
	}
	rc, err := s.open(path)
	if err != nil {
		return ""
	}
	defer rc.Close()
	lr := io.LimitReader(rc, codexFirstLineCap)
	bs, err := io.ReadAll(lr)
	if err != nil {
		return ""
	}
	if nl := strings.IndexByte(string(bs), '\n'); nl >= 0 {
		bs = bs[:nl]
	}
	var obj struct {
		Payload struct {
			CWD string `json:"cwd"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(bs, &obj); err != nil {
		return ""
	}
	return obj.Payload.CWD
}
