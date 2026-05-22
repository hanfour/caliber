package wizard

import (
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
)

func writeFile(t *testing.T, path string, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

// Encode an absolute path into Claude's project-dir convention: replace "/"
// with "-". E.g. "/tmp/foo-bar" → "-tmp-foo-bar".
func encodeClaudeDir(abs string) string {
	return strings.ReplaceAll(abs, "/", "-")
}

func TestScan_DashedRealCWD(t *testing.T) {
	tmp := t.TempDir()
	realDir := filepath.Join(tmp, "test", "dashed-real-name")
	if err := os.MkdirAll(realDir, 0o755); err != nil {
		t.Fatal(err)
	}
	claudeRoot := filepath.Join(tmp, "claude-projects")
	claudeDir := filepath.Join(claudeRoot, encodeClaudeDir(realDir))
	writeFile(t, filepath.Join(claudeDir, "sess.jsonl"),
		`{"type":"user","cwd":"`+realDir+`"}`+"\n")

	cands, err := ScanClaudeProjects(claudeRoot)
	if err != nil {
		t.Fatalf("Scan: %v", err)
	}
	if len(cands) != 1 || cands[0].CWD != realDir {
		t.Fatalf("got %+v, want CWD=%q", cands, realDir)
	}
}

func TestScan_CleanCWD(t *testing.T) {
	tmp := t.TempDir()
	realDir := filepath.Join(tmp, "test", "plain")
	if err := os.MkdirAll(realDir, 0o755); err != nil {
		t.Fatal(err)
	}
	claudeRoot := filepath.Join(tmp, "claude-projects")
	claudeDir := filepath.Join(claudeRoot, encodeClaudeDir(realDir))
	writeFile(t, filepath.Join(claudeDir, "sess.jsonl"),
		`{"type":"user","cwd":"`+realDir+`"}`+"\n")

	cands, err := ScanClaudeProjects(claudeRoot)
	if err != nil {
		t.Fatalf("Scan: %v", err)
	}
	if len(cands) != 1 || cands[0].CWD != realDir {
		t.Fatalf("got %+v", cands)
	}
}

func TestScan_NoLeadingDashSkipped(t *testing.T) {
	tmp := t.TempDir()
	claudeRoot := filepath.Join(tmp, "claude-projects")
	writeFile(t, filepath.Join(claudeRoot, "not-a-claude-project", "x.jsonl"), `{"cwd":"`+tmp+`"}`)
	cands, err := ScanClaudeProjects(claudeRoot)
	if err != nil {
		t.Fatalf("Scan: %v", err)
	}
	if len(cands) != 0 {
		t.Fatalf("expected 0 candidates, got %+v", cands)
	}
}

func TestScan_StaleCWDSkipped(t *testing.T) {
	tmp := t.TempDir()
	claudeRoot := filepath.Join(tmp, "claude-projects")
	claudeDir := filepath.Join(claudeRoot, "-nonexistent-path")
	writeFile(t, filepath.Join(claudeDir, "s.jsonl"), `{"cwd":"/path/that/does/not/exist"}`)
	cands, _ := ScanClaudeProjects(claudeRoot)
	if len(cands) != 0 {
		t.Fatalf("expected 0, got %+v", cands)
	}
}

func TestScan_CorruptJSONLFallbackToDirname(t *testing.T) {
	tmp := t.TempDir()
	realDir := filepath.Join(tmp, "test", "fb")
	if err := os.MkdirAll(realDir, 0o755); err != nil {
		t.Fatal(err)
	}
	claudeRoot := filepath.Join(tmp, "claude-projects")
	claudeDir := filepath.Join(claudeRoot, encodeClaudeDir(realDir))
	writeFile(t, filepath.Join(claudeDir, "bad.jsonl"), "this is not json\n")

	cands, _ := ScanClaudeProjects(claudeRoot)
	if len(cands) != 1 || cands[0].CWD != realDir {
		t.Fatalf("got %+v, want %q", cands, realDir)
	}
}

func TestScan_NoJSONLFallbackToDirname(t *testing.T) {
	tmp := t.TempDir()
	realDir := filepath.Join(tmp, "test", "empty-proj")
	if err := os.MkdirAll(realDir, 0o755); err != nil {
		t.Fatal(err)
	}
	claudeRoot := filepath.Join(tmp, "claude-projects")
	claudeDir := filepath.Join(claudeRoot, encodeClaudeDir(realDir))
	if err := os.MkdirAll(claudeDir, 0o755); err != nil {
		t.Fatal(err)
	}
	cands, _ := ScanClaudeProjects(claudeRoot)
	if len(cands) != 1 || cands[0].CWD != realDir {
		t.Fatalf("got %+v, want %q", cands, realDir)
	}
	if cands[0].SessionCt != 0 {
		t.Errorf("SessionCt = %d, want 0", cands[0].SessionCt)
	}
}

// Cases 6 + 7 use the unexported scanClaudeProjects test seam to inject a
// byte-counter opener.
type countingReader struct {
	r io.ReadCloser
	n *int64
}

func (c *countingReader) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	atomic.AddInt64(c.n, int64(n))
	return n, err
}
func (c *countingReader) Close() error { return c.r.Close() }

func TestScan_ByteBudgetExhaustedManySmallLines(t *testing.T) {
	tmp := t.TempDir()
	claudeRoot := filepath.Join(tmp, "claude-projects")
	claudeDir := filepath.Join(claudeRoot, "-nonexistent-bigfile")
	if err := os.MkdirAll(claudeDir, 0o755); err != nil {
		t.Fatal(err)
	}
	// 300 KiB of "no cwd" lines, exceeds 256 KiB budget.
	f, err := os.Create(filepath.Join(claudeDir, "big.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	line := `{"type":"noise","payload":"` + strings.Repeat("x", 200) + `"}` + "\n"
	for i := 0; i < 1500; i++ {
		f.WriteString(line)
	}
	f.Close()

	var bytesRead int64
	opener := func(p string) (io.ReadCloser, error) {
		f, err := os.Open(p)
		if err != nil {
			return nil, err
		}
		return &countingReader{r: f, n: &bytesRead}, nil
	}
	cands, _ := scanClaudeProjects(claudeRoot, opener)
	if len(cands) != 0 {
		t.Errorf("expected 0 candidates (fallback dirname is invalid), got %+v", cands)
	}
	if bytesRead > 256*1024 {
		t.Errorf("bytesRead = %d, want ≤ 256 KiB", bytesRead)
	}
}

// TestScan_DeepDashedComponent exercises greedyDecode2 — the helper that
// keeps building a component when the dash-as-separator interpretation
// fails. The fixture path has multiple dashes in one final component, so
// the decoder must walk through several "dash is literal" decisions.
func TestScan_DeepDashedComponent(t *testing.T) {
	tmp := t.TempDir()
	// /<tmp>/test/multi-dash-component-name — 3 native hyphens in the final segment
	realDir := filepath.Join(tmp, "test", "multi-dash-component-name")
	if err := os.MkdirAll(realDir, 0o755); err != nil {
		t.Fatal(err)
	}
	claudeRoot := filepath.Join(tmp, "claude-projects")
	claudeDir := filepath.Join(claudeRoot, encodeClaudeDir(realDir))
	// Force the dirname-fallback path: directory exists but has no JSONL.
	if err := os.MkdirAll(claudeDir, 0o755); err != nil {
		t.Fatal(err)
	}
	cands, err := ScanClaudeProjects(claudeRoot)
	if err != nil {
		t.Fatalf("Scan: %v", err)
	}
	if len(cands) != 1 {
		t.Fatalf("expected 1 candidate, got %+v", cands)
	}
	if cands[0].CWD != realDir {
		t.Errorf("CWD = %q, want %q", cands[0].CWD, realDir)
	}
}

// TestScan_NoValidDecodingReturnsNothing exercises the all-options-fail
// path: a dirname that doesn't decode to ANY existing directory, neither
// via separator nor via literal-hyphen interpretations.
func TestScan_NoValidDecodingReturnsNothing(t *testing.T) {
	tmp := t.TempDir()
	claudeRoot := filepath.Join(tmp, "claude-projects")
	claudeDir := filepath.Join(claudeRoot, "-this-decodes-to-nowhere-real")
	if err := os.MkdirAll(claudeDir, 0o755); err != nil {
		t.Fatal(err)
	}
	cands, _ := ScanClaudeProjects(claudeRoot)
	if len(cands) != 0 {
		t.Errorf("expected 0 candidates, got %+v", cands)
	}
}

func TestScan_GiantSingleLineBounded(t *testing.T) {
	tmp := t.TempDir()
	claudeRoot := filepath.Join(tmp, "claude-projects")
	claudeDir := filepath.Join(claudeRoot, "-nonexistent-giant")
	if err := os.MkdirAll(claudeDir, 0o755); err != nil {
		t.Fatal(err)
	}
	// 20 MiB single-line JSONL with no newline.
	f, err := os.Create(filepath.Join(claudeDir, "huge.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	chunk := strings.Repeat("x", 64*1024)
	for i := 0; i < 320; i++ { // 320 × 64 KiB = 20 MiB
		f.WriteString(chunk)
	}
	f.Close()

	var bytesRead int64
	opener := func(p string) (io.ReadCloser, error) {
		f, err := os.Open(p)
		if err != nil {
			return nil, err
		}
		return &countingReader{r: f, n: &bytesRead}, nil
	}
	cands, _ := scanClaudeProjects(claudeRoot, opener)
	if len(cands) != 0 {
		t.Errorf("expected 0 candidates, got %+v", cands)
	}
	if bytesRead > 256*1024 {
		t.Errorf("bytesRead = %d, want ≤ 256 KiB (io.LimitReader bound violated)", bytesRead)
	}
}
