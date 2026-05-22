package watcher

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func mkdir(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(path, 0o755); err != nil {
		t.Fatal(err)
	}
}

func write(t *testing.T, path string, content string) {
	t.Helper()
	mkdir(t, filepath.Dir(path))
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestClaudeSource_ListMainAndSubagent(t *testing.T) {
	root := t.TempDir()

	proj := filepath.Join(root, "-Users-h-proj")
	write(t, filepath.Join(proj, "00000000-0000-0000-0000-000000000001.jsonl"), "{}\n")
	write(t, filepath.Join(proj, "00000000-0000-0000-0000-000000000002.jsonl"), "{}\n")
	write(t, filepath.Join(proj, "00000000-0000-0000-0000-000000000001", "subagents",
		"agent-abc123.jsonl"), "{}\n")

	write(t, filepath.Join(root, "not-a-claude-project", "x.jsonl"), "{}\n")
	write(t, filepath.Join(proj, "README.md"), "x")

	s := NewClaudeSource(root)
	if s.Name() != "claude" {
		t.Errorf("Name() = %q, want %q", s.Name(), "claude")
	}

	refs, err := s.List(context.Background())
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(refs) != 3 {
		t.Fatalf("got %d refs, want 3 (2 main + 1 subagent): %+v", len(refs), refs)
	}

	byPath := map[string]FileRef{}
	for _, r := range refs {
		byPath[r.Path] = r
	}

	main1 := byPath[filepath.Join(proj, "00000000-0000-0000-0000-000000000001.jsonl")]
	if main1.Source != "claude" {
		t.Errorf("main1 source = %q", main1.Source)
	}
	if main1.SessionID != "00000000-0000-0000-0000-000000000001" {
		t.Errorf("main1 SessionID = %q", main1.SessionID)
	}
	if main1.ParentSessionID != "" {
		t.Errorf("main1 ParentSessionID should be empty, got %q", main1.ParentSessionID)
	}
	if main1.CWD != "" {
		t.Errorf("main1 CWD should be empty (filled by resolver), got %q", main1.CWD)
	}

	subPath := filepath.Join(proj, "00000000-0000-0000-0000-000000000001", "subagents",
		"agent-abc123.jsonl")
	sub := byPath[subPath]
	if sub.Source != "claude-subagent" {
		t.Errorf("sub source = %q", sub.Source)
	}
	if sub.SessionID != "abc123" {
		t.Errorf("sub SessionID = %q, want %q", sub.SessionID, "abc123")
	}
	if sub.ParentSessionID != "00000000-0000-0000-0000-000000000001" {
		t.Errorf("sub ParentSessionID = %q", sub.ParentSessionID)
	}
}
