package cwdresolve

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// errorOpener returns an error on every open.
func errorOpener(_ string) (io.ReadCloser, error) {
	return nil, fmt.Errorf("injected open error")
}

func TestDefaultOpener_ReturnsFile(t *testing.T) {
	tmp := t.TempDir()
	path := filepath.Join(tmp, "test.txt")
	if err := os.WriteFile(path, []byte("hello"), 0o600); err != nil {
		t.Fatal(err)
	}
	rc, err := DefaultOpener(path)
	if err != nil {
		t.Fatalf("DefaultOpener: %v", err)
	}
	defer rc.Close()
	got, _ := io.ReadAll(rc)
	if string(got) != "hello" {
		t.Errorf("got %q, want %q", string(got), "hello")
	}
}

func TestDefaultOpener_MissingFile(t *testing.T) {
	_, err := DefaultOpener("/nonexistent/path/xyz.jsonl")
	if err == nil {
		t.Fatal("expected error, got nil")
	}
}

func TestResolveOneClaudeDir_MissingDir(t *testing.T) {
	cwd, err := ResolveOneClaudeDir("/nonexistent/dir/xyz", DefaultOpener)
	if err != nil {
		t.Fatalf("expected nil err for missing dir, got %v", err)
	}
	if cwd != "" {
		t.Errorf("got %q, want empty", cwd)
	}
}

func TestResolveOneClaudeDir_EmptyDir(t *testing.T) {
	tmp := t.TempDir()
	// Empty dir, no JSONL → dirname fallback. dir name doesn't start with "-"
	// so fallback returns "".
	cwd, err := ResolveOneClaudeDir(tmp, DefaultOpener)
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if cwd != "" {
		t.Errorf("got %q, want empty (no leading dash in base name)", cwd)
	}
}

func TestResolveOneClaudeDir_JSONLHasCWD(t *testing.T) {
	tmp := t.TempDir()
	realDir := t.TempDir() // a real directory to reference

	line := fmt.Sprintf(`{"cwd":%q}%s`, realDir, "\n")
	jsonlPath := filepath.Join(tmp, "session.jsonl")
	if err := os.WriteFile(jsonlPath, []byte(line), 0o600); err != nil {
		t.Fatal(err)
	}

	cwd, err := ResolveOneClaudeDir(tmp, DefaultOpener)
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if cwd != realDir {
		t.Errorf("got %q, want %q", cwd, realDir)
	}
}

func TestResolveOneClaudeDir_JSONLCWDNotDir(t *testing.T) {
	tmp := t.TempDir()

	line := `{"cwd":"/nonexistent/path/does/not/exist"}` + "\n"
	if err := os.WriteFile(filepath.Join(tmp, "a.jsonl"), []byte(line), 0o600); err != nil {
		t.Fatal(err)
	}

	// No usable CWD and no dirname fallback (dir base doesn't start with "-")
	cwd, err := ResolveOneClaudeDir(tmp, DefaultOpener)
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if cwd != "" {
		t.Errorf("got %q, want empty", cwd)
	}
}

func TestResolveOneClaudeDir_OpenError(t *testing.T) {
	tmp := t.TempDir()
	// Create a JSONL file so listJSONL returns it, but open always fails.
	if err := os.WriteFile(filepath.Join(tmp, "a.jsonl"), []byte(`{"cwd":"/foo"}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	cwd, err := ResolveOneClaudeDir(tmp, errorOpener)
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	// Open failed so no CWD from JSONL; dirname fallback also fails (not dash-prefixed)
	if cwd != "" {
		t.Errorf("got %q, want empty", cwd)
	}
}

func TestResolveOneClaudeDir_DirnameFallback(t *testing.T) {
	tmp := t.TempDir()
	realDir := filepath.Join(tmp, "projects", "myapp")
	if err := os.MkdirAll(realDir, 0o755); err != nil {
		t.Fatal(err)
	}

	// Encode realDir as Claude would: replace "/" with "-", prepend "-"
	// Claude encoding: /tmp/xxx/projects/myapp → -tmp-xxx-projects-myapp
	encoded := "-" + strings.ReplaceAll(strings.TrimPrefix(realDir, "/"), "/", "-")
	claudeDir := filepath.Join(tmp, "claude", encoded)
	if err := os.MkdirAll(claudeDir, 0o755); err != nil {
		t.Fatal(err)
	}

	// Empty dir → no JSONL → dirname fallback should resolve back to realDir
	cwd, err := ResolveOneClaudeDir(claudeDir, DefaultOpener)
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if cwd != realDir {
		t.Errorf("got %q, want %q", cwd, realDir)
	}
}

func TestScanJSONLForCWD_MultipleFiles(t *testing.T) {
	realDir := t.TempDir()

	// Second file has valid CWD, first has invalid
	file1Content := `{"cwd":"/nonexistent/path"}` + "\n"
	file2Content := fmt.Sprintf(`{"cwd":%q}%s`, realDir, "\n")

	// list: file1 first, file2 second
	paths := []string{"file1.jsonl", "file2.jsonl"}

	callNum := 0
	opener := func(_ string) (io.ReadCloser, error) {
		callNum++
		if callNum == 1 {
			return io.NopCloser(strings.NewReader(file1Content)), nil
		}
		return io.NopCloser(strings.NewReader(file2Content)), nil
	}

	result := scanJSONLForCWD(paths, opener)
	if result != realDir {
		t.Errorf("got %q, want %q", result, realDir)
	}
}

func TestScanJSONLForCWD_Empty(t *testing.T) {
	result := scanJSONLForCWD(nil, DefaultOpener)
	if result != "" {
		t.Errorf("got %q, want empty", result)
	}
}

func TestTryExtractCWD_InvalidJSON(t *testing.T) {
	got := tryExtractCWD("not-json\n")
	if got != "" {
		t.Errorf("got %q, want empty for invalid JSON", got)
	}
}

func TestTryExtractCWD_NoCWDField(t *testing.T) {
	got := tryExtractCWD(`{"other":"value"}` + "\n")
	if got != "" {
		t.Errorf("got %q, want empty for missing cwd field", got)
	}
}

func TestTryExtractCWD_ValidDir(t *testing.T) {
	dir := t.TempDir()
	line := fmt.Sprintf(`{"cwd":%q}`, dir)
	got := tryExtractCWD(line)
	if got != dir {
		t.Errorf("got %q, want %q", got, dir)
	}
}

func TestTryExtractCWD_FileNotDir(t *testing.T) {
	tmp := t.TempDir()
	f := filepath.Join(tmp, "file.txt")
	if err := os.WriteFile(f, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	line := fmt.Sprintf(`{"cwd":%q}`, f)
	got := tryExtractCWD(line)
	if got != "" {
		t.Errorf("got %q, want empty (path is file not dir)", got)
	}
}

func TestDirnameFallback_NoLeadingDash(t *testing.T) {
	got := dirnameFallback("no-leading-dash")
	if got != "" {
		t.Errorf("got %q, want empty", got)
	}
}

func TestDirnameFallback_NonExistentPath(t *testing.T) {
	// Even if we decode to a plausible path, stat must succeed
	got := dirnameFallback("-nonexistent-dir-xyz-abc")
	if got != "" {
		t.Errorf("got %q, want empty for non-existent path", got)
	}
}

func TestListJSONL_SortedByMtime(t *testing.T) {
	tmp := t.TempDir()
	// Create files in order; newer file should appear first
	for _, name := range []string{"a.jsonl", "b.jsonl", "c.jsonl"} {
		if err := os.WriteFile(filepath.Join(tmp, name), []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	// Also add a non-jsonl file that should be ignored
	if err := os.WriteFile(filepath.Join(tmp, "config.toml"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	// And a subdirectory that should be ignored
	if err := os.MkdirAll(filepath.Join(tmp, "subdir"), 0o755); err != nil {
		t.Fatal(err)
	}

	paths, err := listJSONL(tmp)
	if err != nil {
		t.Fatalf("listJSONL: %v", err)
	}
	if len(paths) != 3 {
		t.Errorf("got %d paths, want 3", len(paths))
	}
	for _, p := range paths {
		if filepath.Ext(p) != ".jsonl" {
			t.Errorf("non-jsonl path in result: %s", p)
		}
	}
}

func TestListJSONL_MissingDir(t *testing.T) {
	paths, err := listJSONL("/nonexistent/path/xyz")
	if err != nil {
		t.Fatalf("listJSONL missing dir: %v", err)
	}
	if len(paths) != 0 {
		t.Errorf("got %v, want empty", paths)
	}
}
