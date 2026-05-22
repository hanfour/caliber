package cli

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/hanfour/ai-dev-eval/agent/internal/config"
	"github.com/hanfour/ai-dev-eval/agent/internal/keychain"
)

func setupEnrolledHome(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("CALIBER_AGENT_HOME", home)

	scriptDir := t.TempDir()
	script := "#!/bin/sh\necho cda_dummy\n"
	scriptPath := filepath.Join(scriptDir, "security")
	if err := os.WriteFile(scriptPath, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	orig := keychain.SecurityBin
	keychain.SecurityBin = scriptPath
	t.Cleanup(func() { keychain.SecurityBin = orig })

	if err := config.Save(&config.Config{
		DeviceID:     "dev-abc",
		Hostname:     "h4",
		OS:           "darwin",
		APIBaseURL:   "http://localhost:3001",
		Mode:         "metadata-only",
		IncludePaths: []string{home + "/projects/allowed"},
	}); err != nil {
		t.Fatal(err)
	}
	return home
}

func TestRun_NotEnrolled_ReturnsExit1(t *testing.T) {
	t.Setenv("CALIBER_AGENT_HOME", t.TempDir())

	cmd := New()
	var buf bytes.Buffer
	cmd.SetOut(&buf)
	cmd.SetErr(&buf)
	cmd.SetArgs([]string{"run", "--once"})
	err := cmd.ExecuteContext(context.Background())

	var ee *ExitError
	if !errors.As(err, &ee) {
		t.Fatalf("err = %v, want *ExitError", err)
	}
	if ee.Code != 1 {
		t.Errorf("Code = %d, want 1", ee.Code)
	}
	if !strings.Contains(err.Error(), "not enrolled") {
		t.Errorf("expected 'not enrolled' in: %v", err)
	}
}

func TestRun_KeychainMissing_ReturnsExit1(t *testing.T) {
	home := t.TempDir()
	t.Setenv("CALIBER_AGENT_HOME", home)
	if err := config.Save(&config.Config{DeviceID: "dev-x"}); err != nil {
		t.Fatal(err)
	}
	scriptDir := t.TempDir()
	script := "#!/bin/sh\nexit 44\n"
	scriptPath := filepath.Join(scriptDir, "security")
	os.WriteFile(scriptPath, []byte(script), 0o755)
	orig := keychain.SecurityBin
	keychain.SecurityBin = scriptPath
	t.Cleanup(func() { keychain.SecurityBin = orig })

	cmd := New()
	var buf bytes.Buffer
	cmd.SetOut(&buf)
	cmd.SetErr(&buf)
	cmd.SetArgs([]string{"run", "--once"})
	err := cmd.ExecuteContext(context.Background())
	if err == nil || !strings.Contains(err.Error(), "device key missing") {
		t.Errorf("expected device-key-missing error, got %v", err)
	}
}

func TestRun_OnceWithEmptyAllowList_TicksAndExits(t *testing.T) {
	home := setupEnrolledHome(t)

	claudeRoot := filepath.Join(home, "claude-projects-empty")
	codexRoot := filepath.Join(home, "codex-sessions-empty")
	os.MkdirAll(claudeRoot, 0o755)
	os.MkdirAll(codexRoot, 0o755)
	t.Setenv("CALIBER_CLAUDE_PROJECTS", claudeRoot)
	t.Setenv("CALIBER_CODEX_SESSIONS", codexRoot)

	cmd := New()
	var buf bytes.Buffer
	cmd.SetOut(&buf)
	cmd.SetErr(&buf)
	cmd.SetArgs([]string{"run", "--once"})
	if err := cmd.ExecuteContext(context.Background()); err != nil {
		t.Fatalf("run --once: %v", err)
	}

	logPath := filepath.Join(home, "agent.log")
	bs, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatalf("read agent.log: %v", err)
	}
	if !strings.Contains(string(bs), "[tick-end]") {
		t.Errorf("agent.log missing [tick-end]: %q", bs)
	}
}

func TestRun_OnceWithMatchingFile_ProducesChunkLine(t *testing.T) {
	home := setupEnrolledHome(t)

	allowed := filepath.Join(home, "projects", "allowed")
	os.MkdirAll(allowed, 0o755)
	if err := config.Save(&config.Config{
		DeviceID:     "dev-abc",
		IncludePaths: []string{allowed},
	}); err != nil {
		t.Fatal(err)
	}

	claudeRoot := filepath.Join(home, "claude-projects")
	t.Setenv("CALIBER_CLAUDE_PROJECTS", claudeRoot)
	t.Setenv("CALIBER_CODEX_SESSIONS", filepath.Join(home, "codex-empty"))
	os.MkdirAll(filepath.Join(home, "codex-empty"), 0o755)

	encoded := "-" + strings.ReplaceAll(strings.TrimPrefix(allowed, "/"), "/", "-")
	projDir := filepath.Join(claudeRoot, encoded)
	if err := os.MkdirAll(projDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(projDir, "sess.jsonl"),
		[]byte(`{"type":"user","cwd":"`+allowed+`"}`+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	cmd := New()
	var buf bytes.Buffer
	cmd.SetOut(&buf)
	cmd.SetErr(&buf)
	cmd.SetArgs([]string{"run", "--once"})
	if err := cmd.ExecuteContext(context.Background()); err != nil {
		t.Fatalf("run --once: %v", err)
	}

	bs, err := os.ReadFile(filepath.Join(home, "agent.log"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(bs), "[chunk]") {
		t.Errorf("agent.log missing [chunk] line: %q", bs)
	}
}

func TestRun_PersistentMode_TicksMultipleTimesUntilCancel(t *testing.T) {
	home := setupEnrolledHome(t)
	t.Setenv("CALIBER_CLAUDE_PROJECTS", filepath.Join(home, "c-empty"))
	t.Setenv("CALIBER_CODEX_SESSIONS", filepath.Join(home, "cx-empty"))
	os.MkdirAll(filepath.Join(home, "c-empty"), 0o755)
	os.MkdirAll(filepath.Join(home, "cx-empty"), 0o755)

	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		// Wait long enough for ≥ 2 ticks at 50ms interval, then simulate SIGTERM.
		time.Sleep(3 * time.Second)
		cancel()
	}()

	cmd := New()
	var buf bytes.Buffer
	cmd.SetOut(&buf)
	cmd.SetErr(&buf)
	cmd.SetArgs([]string{"run", "--interval", "50ms"})

	err := cmd.ExecuteContext(ctx)
	if !errors.Is(err, context.Canceled) {
		t.Errorf("expected context.Canceled (will map to exit 130 via root.Execute), got %v", err)
	}

	bs, _ := os.ReadFile(filepath.Join(home, "agent.log"))
	if strings.Count(string(bs), "[tick-end]") < 2 {
		t.Errorf("expected multiple [tick-end] lines, got %q", bs)
	}
}
