package cli

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"

	"github.com/hanfour/ai-dev-eval/agent/internal/config"
)

// executeCLI runs the cobra root with the given args under a background
// context and returns the exit code that root.Execute would have produced.
// It is a generic equivalent of executeRunOnce and is used by all Phase 9+
// subcommand tests.
func executeCLI(t *testing.T, args []string) int {
	t.Helper()
	cmd := New()
	var buf bytes.Buffer
	cmd.SetOut(&buf)
	cmd.SetErr(&buf)
	cmd.SetArgs(args)
	err := cmd.ExecuteContext(context.Background())
	if err == nil {
		return 0
	}
	var ee *ExitError
	if errors.As(err, &ee) {
		return ee.Code
	}
	if errors.Is(err, context.Canceled) {
		return 130
	}
	return 1
}

// executeCLIWithStdin temporarily replaces os.Stdin with a pipe carrying the
// given input bytes, then runs the CLI. Used by add-path/uninstall consent
// prompts that read from os.Stdin (bufio.NewReader(os.Stdin)).
//
// Stdin is restored even if the test panics. The pipe is closed once the
// writer-side has finished — readers see EOF after the supplied bytes.
func executeCLIWithStdin(t *testing.T, stdin string, args []string) int {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("pipe: %v", err)
	}
	go func() {
		defer w.Close()
		_, _ = io.WriteString(w, stdin)
	}()
	origStdin := os.Stdin
	os.Stdin = r
	t.Cleanup(func() {
		os.Stdin = origStdin
		_ = r.Close()
	})
	return executeCLI(t, args)
}

func TestAddPath_HappyPath_Atomic(t *testing.T) {
	setupEnrolledRoot(t)
	target := t.TempDir()
	code := executeCLI(t, []string{"add-path", target, "--yes"})
	if code != 0 {
		t.Fatalf("want 0, got %d", code)
	}
	cfg, _ := config.Load()
	// Path may be normalised through EvalSymlinks; compare against the
	// canonical form too.
	canonical, _ := filepath.EvalSymlinks(target)
	canonical = filepath.Clean(canonical)
	found := false
	for _, p := range cfg.IncludePaths {
		if p == target || p == canonical {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected %s (or %s) in IncludePaths, got %v",
			target, canonical, cfg.IncludePaths)
	}
}

func TestAddPath_NotAbsolute_Exit64(t *testing.T) {
	setupEnrolledRoot(t)
	code := executeCLI(t, []string{"add-path", "relative/path", "--yes"})
	if code != 64 {
		t.Fatalf("want 64, got %d", code)
	}
}

func TestAddPath_NonExistent_Exit1(t *testing.T) {
	setupEnrolledRoot(t)
	code := executeCLI(t, []string{"add-path", "/no/such/path", "--yes"})
	if code != 1 {
		t.Fatalf("want 1, got %d", code)
	}
}

func TestAddPath_AlreadyInList_NoOp(t *testing.T) {
	setupEnrolledRoot(t)
	target := t.TempDir()
	canonical, err := filepath.EvalSymlinks(target)
	if err != nil {
		t.Fatal(err)
	}
	canonical = filepath.Clean(canonical)
	// Pre-populate IncludePaths with the canonical form so the duplicate
	// check matches.
	cfg, _ := config.Load()
	cfg.IncludePaths = []string{canonical}
	if err := config.SaveConfig(cfg); err != nil {
		t.Fatal(err)
	}

	code := executeCLI(t, []string{"add-path", target, "--yes"})
	if code != 0 {
		t.Fatalf("idempotent want 0, got %d", code)
	}
	cfg2, _ := config.Load()
	count := 0
	for _, p := range cfg2.IncludePaths {
		if p == canonical {
			count++
		}
	}
	if count != 1 {
		t.Fatalf("duplicate not allowed; got %d entries: %v", count, cfg2.IncludePaths)
	}
}

func TestAddPath_SymlinkInput_NormalisedToReal(t *testing.T) {
	setupEnrolledRoot(t)
	// Clear the seed IncludePaths so we can assert the new entry is the
	// only one (and lives at index 0).
	cfg0, _ := config.Load()
	cfg0.IncludePaths = []string{}
	if err := config.SaveConfig(cfg0); err != nil {
		t.Fatal(err)
	}
	realDir := t.TempDir()
	realCanonical, err := filepath.EvalSymlinks(realDir)
	if err != nil {
		t.Fatal(err)
	}
	realCanonical = filepath.Clean(realCanonical)
	linkParent := t.TempDir()
	link := filepath.Join(linkParent, "code")
	if err := os.Symlink(realDir, link); err != nil {
		t.Fatal(err)
	}
	code := executeCLI(t, []string{"add-path", link, "--yes"})
	if code != 0 {
		t.Fatalf("got %d", code)
	}
	cfg, _ := config.Load()
	if len(cfg.IncludePaths) != 1 {
		t.Fatalf("expected 1 entry, got %v", cfg.IncludePaths)
	}
	if cfg.IncludePaths[0] != realCanonical {
		t.Fatalf("expected normalised path %s, got %s", realCanonical, cfg.IncludePaths[0])
	}
}

func TestAddPath_ConsentDeclined_Exit130(t *testing.T) {
	setupEnrolledRoot(t)
	// Snapshot IncludePaths before the decline so we can assert no mutation.
	before, _ := config.Load()
	beforeLen := len(before.IncludePaths)

	target := t.TempDir()
	code := executeCLIWithStdin(t, "n\n", []string{"add-path", target})
	if code != 130 {
		t.Fatalf("want 130, got %d", code)
	}
	after, _ := config.Load()
	if len(after.IncludePaths) != beforeLen {
		t.Fatalf("decline must not mutate, got %v (was %v)", after.IncludePaths, before.IncludePaths)
	}
	canonical, _ := filepath.EvalSymlinks(target)
	canonical = filepath.Clean(canonical)
	for _, p := range after.IncludePaths {
		if p == target || p == canonical {
			t.Fatalf("decline must not add %s, got %v", target, after.IncludePaths)
		}
	}
}

func TestAddPath_NonTTY_NoYes_Exit130(t *testing.T) {
	setupEnrolledRoot(t)
	target := t.TempDir()
	// Run with the default os.Stdin (not a TTY in `go test`).
	code := executeCLI(t, []string{"add-path", target})
	if code != 130 {
		t.Fatalf("want 130 non-TTY without --yes, got %d", code)
	}
}
