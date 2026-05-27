package watcher

import (
	"context"
	"os"
	"path/filepath"
	"strings"
)

// ClaudeSource walks ~/.claude/projects/ and yields one FileRef per
// transcript: main sessions at <root>/<encoded-cwd>/*.jsonl plus any
// subagent sessions at <root>/<encoded-cwd>/<sessionID>/subagents/agent-*.jsonl.
//
// FileRef.CWD is intentionally left empty. The loop's CWDResolver
// resolves it per-DIR (cached) because all sessions in the same
// <encoded-cwd>/ share the same cwd, and the dirname-decode is lossy
// for paths with native hyphens (see spec §4.5 / wizard.ScanClaudeProjects).
type ClaudeSource struct {
	Root string
}

func NewClaudeSource(root string) *ClaudeSource { return &ClaudeSource{Root: root} }

func (s *ClaudeSource) Name() string { return "claude" }

func (s *ClaudeSource) List(ctx context.Context) ([]FileRef, error) {
	entries, err := os.ReadDir(s.Root)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var refs []FileRef
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		if !strings.HasPrefix(e.Name(), "-") {
			continue
		}
		projDir := filepath.Join(s.Root, e.Name())
		mainEntries, err := os.ReadDir(projDir)
		if err != nil {
			continue
		}
		for _, m := range mainEntries {
			if m.IsDir() {
				continue
			}
			if filepath.Ext(m.Name()) != ".jsonl" {
				continue
			}
			// Symlink guard: reject anything not a regular file to prevent
			// attacker-controlled symlinks (e.g. evil.jsonl → /etc/passwd)
			// from escaping the allow-listed project directory.
			info, lerr := os.Lstat(filepath.Join(projDir, m.Name()))
			if lerr != nil || info.Mode()&os.ModeSymlink != 0 {
				continue
			}
			sessionID := strings.TrimSuffix(m.Name(), ".jsonl")
			refs = append(refs, FileRef{
				Path:      filepath.Join(projDir, m.Name()),
				Source:    "claude",
				SessionID: sessionID,
			})
		}
		for _, m := range mainEntries {
			if !m.IsDir() {
				continue
			}
			subDir := filepath.Join(projDir, m.Name(), "subagents")
			subEntries, err := os.ReadDir(subDir)
			if err != nil {
				continue
			}
			for _, s := range subEntries {
				if s.IsDir() {
					continue
				}
				name := s.Name()
				if !strings.HasPrefix(name, "agent-") || !strings.HasSuffix(name, ".jsonl") {
					continue
				}
				// Symlink guard: same rationale as the main-session branch
				// above. Reject any non-regular file before exposing it to
				// the watcher pipeline.
				info, lerr := os.Lstat(filepath.Join(subDir, name))
				if lerr != nil || info.Mode()&os.ModeSymlink != 0 {
					continue
				}
				agentID := strings.TrimSuffix(strings.TrimPrefix(name, "agent-"), ".jsonl")
				refs = append(refs, FileRef{
					Path:            filepath.Join(subDir, name),
					Source:          "claude-subagent",
					SessionID:       agentID,
					ParentSessionID: m.Name(),
				})
			}
		}
	}
	return refs, nil
}
