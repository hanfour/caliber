package cli

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/hanfour/ai-dev-eval/agent/internal/config"
	"github.com/hanfour/ai-dev-eval/agent/internal/keychain"
)

// setupRoot creates a fresh temp dir and points CALIBER_AGENT_HOME at it.
// Mirrors config.setupRoot so cli-package tests can assemble runtime roots
// without dragging the config test helpers in.
func setupRoot(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("CALIBER_AGENT_HOME", dir)
	return dir
}

// setupEnrolledRoot creates a CALIBER_AGENT_HOME with a minimal config.toml
// and an in-test keychain shim that returns a dummy token. It is used by the
// run-command pre-flight / lockfile tests that need runRun to reach the
// post-pre-flight code paths.
func setupEnrolledRoot(t *testing.T) string {
	t.Helper()
	home := setupRoot(t)

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

// executeRunOnce invokes `caliber-agent run` (with whatever args are passed)
// under a background context and returns the exit code that root.Execute
// would have produced. It is the cobra-thin equivalent of running the
// binary in-process.
func executeRunOnce(t *testing.T, args []string) int {
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

// fakeAPIServer spins up a test server that handles /v1/redaction-set and
// /v1/ingest, returning minimal valid responses. Tests that need a real
// API endpoint to avoid HTTPSink retry timeouts use this helper.
func fakeAPIServer(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/redaction-set":
			w.WriteHeader(200)
			w.Write([]byte(`{"patterns":[],"version":"v-test","ttl_seconds":3600}`))
		case "/v1/ingest":
			w.WriteHeader(200)
			w.Write([]byte(`{"ingested":1,"deduped":0,"session_upserts":1,"errors":[]}`))
		default:
			w.WriteHeader(404)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

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

func TestRun_OnceWithMatchingFile_ProducesIngestLine(t *testing.T) {
	home := setupEnrolledHome(t)

	srv := fakeAPIServer(t)

	allowedRaw := filepath.Join(home, "projects", "allowed")
	os.MkdirAll(allowedRaw, 0o755)
	// cwdresolve now canonicalises via EvalSymlinks (PR4 §6); IncludePaths
	// must therefore be the canonical form for the allow-list to match.
	allowed, err := filepath.EvalSymlinks(allowedRaw)
	if err != nil {
		t.Fatal(err)
	}
	if err := config.Save(&config.Config{
		DeviceID:     "dev-abc",
		APIBaseURL:   srv.URL,
		Mode:         "metadata-only",
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
	line := `{"type":"user","uuid":"e-1","timestamp":"2026-05-23T10:00:00Z","cwd":"` + allowed + `","message":{"role":"user","content":"hello"}}`
	if err := os.WriteFile(filepath.Join(projDir, "sess.jsonl"),
		[]byte(line+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	cmd := New()
	var buf bytes.Buffer
	cmd.SetOut(&buf)
	cmd.SetErr(&buf)
	cmd.SetArgs([]string{"run", "--once"})
	if err := cmd.ExecuteContext(context.Background()); err != nil {
		t.Fatalf("run --once: %v\noutput: %s", err, buf.String())
	}

	bs, err := os.ReadFile(filepath.Join(home, "agent.log"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(bs), "[ingest]") {
		t.Errorf("agent.log missing [ingest] line: %q", bs)
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

func TestRun_InvalidMode_ReturnsExit1(t *testing.T) {
	home := setupEnrolledHome(t)
	_ = home

	// Write a config with a typo'd mode.
	if err := config.Save(&config.Config{
		DeviceID:     "dev-abc",
		Hostname:     "h4",
		OS:           "darwin",
		APIBaseURL:   "http://localhost:3001",
		Mode:         "metadta-only", // deliberate typo
		IncludePaths: []string{home + "/projects/allowed"},
	}); err != nil {
		t.Fatal(err)
	}

	cmd := New()
	var buf bytes.Buffer
	cmd.SetOut(&buf)
	cmd.SetErr(&buf)
	cmd.SetArgs([]string{"run", "--once"})
	err := cmd.ExecuteContext(context.Background())
	if err == nil {
		t.Fatal("expected error for invalid mode, got nil")
	}
	var ee *ExitError
	if !errors.As(err, &ee) {
		t.Fatalf("expected *ExitError, got %T: %v", err, err)
	}
	if ee.Code != 1 {
		t.Errorf("expected ExitError{Code:1}, got Code=%d", ee.Code)
	}
	if !strings.Contains(err.Error(), "invalid mode") {
		t.Errorf("expected 'invalid mode' in error: %v", err)
	}
}

func TestRun_OnceEndToEnd_FetchAndIngest(t *testing.T) {
	home := setupEnrolledHome(t)

	var ingestPosts int
	var redactionFetches int
	var capturedIngestBody map[string]any

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/redaction-set":
			redactionFetches++
			w.WriteHeader(200)
			w.Write([]byte(`{"patterns":[{"name":"n","regex":"[0-9]+","replacement":"#"}],"version":"v-1","ttl_seconds":3600}`))
		case "/v1/ingest":
			ingestPosts++
			gr, err := gzip.NewReader(r.Body)
			if err != nil {
				t.Fatalf("gunzip: %v", err)
			}
			raw, _ := io.ReadAll(gr)
			_ = json.Unmarshal(raw, &capturedIngestBody)
			w.WriteHeader(200)
			w.Write([]byte(`{"ingested":1,"deduped":0,"session_upserts":1,"errors":[]}`))
		default:
			t.Errorf("unexpected URL %s", r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer srv.Close()

	allowedRaw := filepath.Join(home, "projects", "allowed")
	os.MkdirAll(allowedRaw, 0o755)
	allowed, err := filepath.EvalSymlinks(allowedRaw)
	if err != nil {
		t.Fatal(err)
	}
	if err := config.Save(&config.Config{
		DeviceID:     "dev-abc",
		APIBaseURL:   srv.URL,
		Mode:         "metadata-only",
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
	os.MkdirAll(projDir, 0o755)
	line := `{"type":"user","uuid":"e-1","timestamp":"2026-05-23T10:00:00Z","cwd":"` + allowed + `","message":{"role":"user","content":"hello"}}`
	os.WriteFile(filepath.Join(projDir, "sess.jsonl"), []byte(line+"\n"), 0o644)

	cmd := New()
	var buf bytes.Buffer
	cmd.SetOut(&buf)
	cmd.SetErr(&buf)
	cmd.SetArgs([]string{"run", "--once"})
	if err := cmd.ExecuteContext(context.Background()); err != nil {
		t.Fatalf("run --once: %v\noutput: %s", err, buf.String())
	}

	if redactionFetches != 1 {
		t.Errorf("redaction-set fetches = %d, want 1", redactionFetches)
	}
	if ingestPosts != 1 {
		t.Errorf("ingest posts = %d, want 1", ingestPosts)
	}
	if capturedIngestBody["redaction_mode"] != "metadata-only" {
		t.Errorf("redaction_mode = %v", capturedIngestBody["redaction_mode"])
	}

	bs, _ := os.ReadFile(filepath.Join(home, "agent.log"))
	log := string(bs)
	if !strings.Contains(log, "[ingest]") {
		t.Errorf("agent.log missing [ingest] line: %q", log)
	}
	if !strings.Contains(log, "[refresh]") {
		t.Errorf("agent.log missing [refresh] line: %q", log)
	}

	rs, err := config.LoadRedactionSet()
	if err != nil {
		t.Fatalf("LoadRedactionSet: %v", err)
	}
	if rs.Version != "v-1" {
		t.Errorf("redaction-set version = %q", rs.Version)
	}
}

// --- Phase 7 Task 7.1: pre-flight read-only checks ------------------------

func TestRun_NoConfigDir_Exit1(t *testing.T) {
	t.Setenv("CALIBER_AGENT_HOME", filepath.Join(t.TempDir(), "absent"))
	code := executeRunOnce(t, []string{"run"})
	if code != 1 {
		t.Fatalf("want exit 1 not-enrolled, got %d", code)
	}
}

func TestRun_DoesNotMkdirAllOnStartup(t *testing.T) {
	root := filepath.Join(t.TempDir(), "absent")
	t.Setenv("CALIBER_AGENT_HOME", root)
	_ = executeRunOnce(t, []string{"run"})
	if _, err := os.Stat(root); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("run must NOT create root when not enrolled, stat err=%v", err)
	}
}

func TestRun_PreflightSentinelExists_NoLockCreated(t *testing.T) {
	root := setupRoot(t)
	if err := os.WriteFile(filepath.Join(root, "config.toml"), []byte(""), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, ".uninstalling"), []byte(""), 0o600); err != nil {
		t.Fatal(err)
	}
	code := executeRunOnce(t, []string{"run"})
	if code != 0 {
		t.Fatalf("want exit 0 (uninstall in progress), got %d", code)
	}
	if _, err := os.Stat(filepath.Join(root, ".lock")); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("run pre-flight must NOT create .lock when sentinel present, stat err=%v", err)
	}
}

func TestRun_PreflightConfigMissing_NoLockCreated(t *testing.T) {
	root := setupRoot(t) // root exists, no config.toml
	code := executeRunOnce(t, []string{"run"})
	if code != 1 {
		t.Fatalf("want exit 1 not enrolled, got %d", code)
	}
	if _, err := os.Stat(filepath.Join(root, ".lock")); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("run pre-flight must NOT create .lock when config.toml missing, stat err=%v", err)
	}
}
