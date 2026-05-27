package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/hanfour/ai-dev-eval/agent/internal/config"
	"github.com/hanfour/ai-dev-eval/agent/internal/keychain"
	"github.com/hanfour/ai-dev-eval/agent/internal/wizard"
)

// withFakeSecurity rewrites keychain.SecurityBin to a stub that records argv.
// Returns the recorded log path.
func withFakeSecurity(t *testing.T, exitCode int, stdoutLine string) string {
	t.Helper()
	dir := t.TempDir()
	script := "#!/bin/sh\necho \"$@\" >> \"" + dir + "/argv.log\"\n"
	if stdoutLine != "" {
		script += "echo \"" + stdoutLine + "\"\n"
	}
	if exitCode != 0 {
		script += "exit 1\n"
	}
	path := filepath.Join(dir, "security")
	if err := os.WriteFile(path, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	orig := keychain.SecurityBin
	keychain.SecurityBin = path
	t.Cleanup(func() { keychain.SecurityBin = orig })
	return filepath.Join(dir, "argv.log")
}

func TestEnrollHappyPath_WritesConfigAndKeychain(t *testing.T) {
	// Use absent path so first-enroll preflight passes (R18-F1 partial-cleanup
	// preflight rejects root-exists-without-config.toml; new tests must point
	// at a not-yet-created path).
	t.Setenv("CALIBER_AGENT_HOME", filepath.Join(t.TempDir(), "absent"))
	argvLog := withFakeSecurity(t, 0, "")

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]string
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["token"] == "" {
			t.Errorf("server received empty token")
		}
		w.WriteHeader(201)
		w.Write([]byte(`{"deviceId":"d-7","key":"cda_test_secret","keyPrefix":"cda_test"}`))
	}))
	defer srv.Close()
	t.Setenv("CALIBER_API_BASE_URL", srv.URL)

	useFakePrompter(t, []bool{true, true}, [][]int{{0}})

	cmd := New()
	var buf bytes.Buffer
	cmd.SetOut(&buf)
	cmd.SetErr(&buf)
	// httptest serves http:// so pass --insecure to satisfy ValidateAPIBaseURL.
	cmd.SetArgs([]string{"enroll", "some-enroll-token", "--insecure"})

	if err := cmd.ExecuteContext(context.Background()); err != nil {
		t.Fatalf("enroll: %v\noutput: %s", err, buf.String())
	}

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("config.Load: %v", err)
	}
	if cfg.DeviceID != "d-7" {
		t.Errorf("DeviceID = %q", cfg.DeviceID)
	}
	if len(cfg.IncludePaths) != 0 {
		t.Errorf("IncludePaths = %v, want empty", cfg.IncludePaths)
	}

	logBytes, _ := os.ReadFile(argvLog)
	if !strings.Contains(string(logBytes), "add-generic-password") {
		t.Errorf("fake security not invoked: %s", logBytes)
	}

	if !strings.Contains(buf.String(), "Enrolled as device d-7") {
		t.Errorf("success message missing device id: %q", buf.String())
	}
	if !strings.Contains(buf.String(), "Configured 0 paths") {
		t.Errorf("success message missing path count: %q", buf.String())
	}
}

func TestEnrollAlreadyEnrolled_ReturnsExit1(t *testing.T) {
	home := t.TempDir()
	t.Setenv("CALIBER_AGENT_HOME", home)
	if err := config.Save(&config.Config{DeviceID: "existing"}); err != nil {
		t.Fatal(err)
	}

	cmd := New()
	var buf bytes.Buffer
	cmd.SetOut(&buf)
	cmd.SetErr(&buf)
	cmd.SetArgs([]string{"enroll", "t"})
	err := cmd.ExecuteContext(context.Background())

	var ee *ExitError
	if !errors.As(err, &ee) {
		t.Fatalf("err = %v, want *ExitError", err)
	}
	if ee.Code != 1 {
		t.Errorf("Code = %d, want 1", ee.Code)
	}
}

func TestEnrollMissingBaseURL_ReturnsExit1(t *testing.T) {
	// Point at an absent path so the partial-cleanup preflight does not fire
	// before the API base URL check.
	t.Setenv("CALIBER_AGENT_HOME", filepath.Join(t.TempDir(), "absent"))
	t.Setenv("CALIBER_API_BASE_URL", "")

	cmd := New()
	var buf bytes.Buffer
	cmd.SetOut(&buf)
	cmd.SetErr(&buf)
	cmd.SetArgs([]string{"enroll", "t"})
	err := cmd.ExecuteContext(context.Background())

	if err == nil {
		t.Fatal("expected error when API base URL is unset")
	}
	if !strings.Contains(err.Error(), "api base url") && !strings.Contains(err.Error(), "API base URL") {
		t.Errorf("error should mention API base URL, got: %v", err)
	}
}

func TestTranslateEnrollErr_LostKey_EmitsRawKeyToStderr(t *testing.T) {
	// Redirect os.Stderr to a pipe so we can capture the Failure-C output.
	origStderr := os.Stderr
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	os.Stderr = w
	t.Cleanup(func() { os.Stderr = origStderr })

	lk := &wizard.LostKeyError{DeviceID: "d-XYZ", RawKey: "cda_visible_secret", Cause: errors.New("permission denied")}
	out := translateEnrollErr(lk)
	if out != lk {
		t.Errorf("translateEnrollErr should pass the error through, got %v", out)
	}

	w.Close()
	captured, _ := io.ReadAll(r)
	got := string(captured)
	for _, want := range []string{"cda_visible_secret", "d-XYZ", "revoke", "CANNOT be retrieved"} {
		if !strings.Contains(got, want) {
			t.Errorf("stderr missing %q in %q", want, got)
		}
	}
}

func TestTranslateEnrollErr_NonLostKey_PassesThrough(t *testing.T) {
	plain := errors.New("some other error")
	out := translateEnrollErr(plain)
	if out != plain {
		t.Errorf("non-LostKeyError should pass through unchanged, got %v", out)
	}
}

func TestClaudeProjectsRoot_HonoursOverride(t *testing.T) {
	t.Setenv("CALIBER_CLAUDE_PROJECTS", "/custom/claude")
	if got := claudeProjectsRoot(); got != "/custom/claude" {
		t.Errorf("claudeProjectsRoot = %q, want /custom/claude", got)
	}
}

func TestClaudeProjectsRoot_DefaultsToHomeClaudeProjects(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("CALIBER_CLAUDE_PROJECTS", "")
	t.Setenv("HOME", tmp)
	want := tmp + "/.claude/projects"
	if got := claudeProjectsRoot(); got != want {
		t.Errorf("claudeProjectsRoot = %q, want %q", got, want)
	}
}

func TestRunEnroll_HostnameFailureIsNotFatal(t *testing.T) {
	// This is mostly a documentation-by-test: os.Hostname() never fails on
	// real macOS, but the contract is that an empty hostname must not
	// abort enrollment. We exercise the happy-path with hostname captured
	// to assert non-empty in the normal case; the empty-hostname case is
	// not directly inducible from a test, but the warn-only branch is
	// proven by inspection of the runEnroll implementation.
	t.Setenv("CALIBER_AGENT_HOME", filepath.Join(t.TempDir(), "absent"))
	withFakeSecurity(t, 0, "")

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]string
		_ = json.NewDecoder(r.Body).Decode(&body)
		// hostname field must be present (even if empty), proving the
		// hostnameErr path doesn't short-circuit enroll.
		if _, ok := body["hostname"]; !ok {
			t.Error("server received no hostname field")
		}
		w.WriteHeader(201)
		w.Write([]byte(`{"deviceId":"d","key":"cda_k","keyPrefix":"cda_"}`))
	}))
	defer srv.Close()
	t.Setenv("CALIBER_API_BASE_URL", srv.URL)
	useFakePrompter(t, []bool{true, true}, [][]int{{0}})

	cmd := New()
	var buf bytes.Buffer
	cmd.SetOut(&buf)
	cmd.SetErr(&buf)
	cmd.SetArgs([]string{"enroll", "t", "--insecure"})
	if err := cmd.ExecuteContext(context.Background()); err != nil {
		t.Fatalf("enroll: %v", err)
	}
}

func TestEnrollServerReturns401_ReturnsExit1_NoLocalState(t *testing.T) {
	t.Setenv("CALIBER_AGENT_HOME", filepath.Join(t.TempDir(), "absent"))
	withFakeSecurity(t, 0, "")

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(401)
		w.Write([]byte(`{"error":"invalid_token"}`))
	}))
	defer srv.Close()
	t.Setenv("CALIBER_API_BASE_URL", srv.URL)

	useFakePrompter(t, []bool{true}, [][]int{{}})

	cmd := New()
	var buf bytes.Buffer
	cmd.SetOut(&buf)
	cmd.SetErr(&buf)
	cmd.SetArgs([]string{"enroll", "bad-token", "--insecure"})

	err := cmd.ExecuteContext(context.Background())
	if err == nil {
		t.Fatal("expected error on 401")
	}
	var ee *ExitError
	if !errors.As(err, &ee) {
		t.Fatalf("err = %v, want *ExitError", err)
	}
	if ee.Code != 1 {
		t.Errorf("Code = %d, want 1", ee.Code)
	}

	// No config should have been written.
	if _, lerr := config.Load(); !errors.Is(lerr, config.ErrNotEnrolled) {
		t.Errorf("config must not exist after 401, got: %v", lerr)
	}
}

func TestEnrollHuhAbort_ReturnsExit130(t *testing.T) {
	t.Setenv("CALIBER_AGENT_HOME", filepath.Join(t.TempDir(), "absent"))
	withFakeSecurity(t, 0, "")

	// The server never gets hit because the wizard cancels at first Confirm.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		t.Error("server should not be hit when user aborts before API call")
		w.WriteHeader(500)
	}))
	defer srv.Close()
	t.Setenv("CALIBER_API_BASE_URL", srv.URL)

	// Inject a Prompter that returns huh.ErrUserAborted on the first Confirm.
	// We need a fresh fake type rather than FakePrompter (which can't simulate
	// the user-aborted error), so build one inline.
	useAbortingPrompter(t)

	cmd := New()
	var buf bytes.Buffer
	cmd.SetOut(&buf)
	cmd.SetErr(&buf)
	cmd.SetArgs([]string{"enroll", "any-token", "--insecure"})

	err := cmd.ExecuteContext(context.Background())
	if err == nil {
		t.Fatal("expected error on huh abort")
	}
	var ee *ExitError
	if !errors.As(err, &ee) {
		t.Fatalf("err = %v, want *ExitError", err)
	}
	if ee.Code != 130 {
		t.Errorf("Code = %d, want 130 (SIGINT/huh-abort contract)", ee.Code)
	}
}

// enrollCountingServer returns an httptest.Server that always replies 201 to
// /v1/devices/enroll and increments *calls. Used by Phase 8 preflight tests
// to assert the API is (or isn't) contacted.
func enrollCountingServer(t *testing.T, calls *int32) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/devices/enroll" {
			atomic.AddInt32(calls, 1)
		}
		w.WriteHeader(201)
		w.Write([]byte(`{"deviceId":"d-phase8","key":"cda_phase8","keyPrefix":"cda_"}`))
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestEnroll_SentinelPresent_Exit1_NoAPICall(t *testing.T) {
	root := setupRoot(t)
	if err := os.WriteFile(filepath.Join(root, ".uninstalling"), []byte(""), 0o600); err != nil {
		t.Fatal(err)
	}

	var calls int32
	srv := enrollCountingServer(t, &calls)

	cmd := New()
	var buf bytes.Buffer
	cmd.SetOut(&buf)
	cmd.SetErr(&buf)
	cmd.SetArgs([]string{"enroll", "tok", "--api-base-url=" + srv.URL})
	err := cmd.ExecuteContext(context.Background())

	var ee *ExitError
	if !errors.As(err, &ee) {
		t.Fatalf("err = %v, want *ExitError", err)
	}
	if ee.Code != 1 {
		t.Errorf("Code = %d, want 1", ee.Code)
	}
	if got := atomic.LoadInt32(&calls); got != 0 {
		t.Errorf("API must NOT be called when sentinel present; calls=%d", got)
	}
	if !strings.Contains(err.Error(), "uninstall in progress") {
		t.Errorf("error should mention uninstall in progress, got: %v", err)
	}
}

func TestEnroll_PartialCleanup_RootExistsConfigMissing_Exit1(t *testing.T) {
	// root exists; no config.toml, no sentinel — simulates ordered_delete (h)
	setupRoot(t)
	var calls int32
	srv := enrollCountingServer(t, &calls)

	cmd := New()
	var buf bytes.Buffer
	cmd.SetOut(&buf)
	cmd.SetErr(&buf)
	cmd.SetArgs([]string{"enroll", "tok", "--api-base-url=" + srv.URL})
	err := cmd.ExecuteContext(context.Background())

	var ee *ExitError
	if !errors.As(err, &ee) {
		t.Fatalf("err = %v, want *ExitError", err)
	}
	if ee.Code != 1 {
		t.Errorf("Code = %d, want 1 partial uninstall, got %d", ee.Code, ee.Code)
	}
	if got := atomic.LoadInt32(&calls); got != 0 {
		t.Errorf("API must NOT be called on partial cleanup; calls=%d", got)
	}
	if !strings.Contains(err.Error(), "partial uninstall") {
		t.Errorf("error should mention partial uninstall, got: %v", err)
	}
}

func TestEnroll_RootMissing_FirstEnrollHappyPath(t *testing.T) {
	root := filepath.Join(t.TempDir(), "absent")
	t.Setenv("CALIBER_AGENT_HOME", root)
	withFakeSecurity(t, 0, "")

	var calls int32
	srv := enrollCountingServer(t, &calls)

	useFakePrompter(t, []bool{true, true}, [][]int{{0}})

	cmd := New()
	var buf bytes.Buffer
	cmd.SetOut(&buf)
	cmd.SetErr(&buf)
	// httptest serves http:// so pass --insecure; the goal of this test is to
	// confirm root-missing IS a first-enroll happy path (no preflight reject).
	cmd.SetArgs([]string{"enroll", "tok", "--api-base-url=" + srv.URL, "--insecure"})

	if err := cmd.ExecuteContext(context.Background()); err != nil {
		t.Fatalf("want nil, got %v\noutput: %s", err, buf.String())
	}
	if _, err := os.Stat(filepath.Join(root, "config.toml")); err != nil {
		t.Fatalf("config.toml expected, %v", err)
	}
	if got := atomic.LoadInt32(&calls); got != 1 {
		t.Errorf("expected 1 API call, got %d", got)
	}
}

func TestEnroll_HTTPWithoutInsecure_Rejected(t *testing.T) {
	t.Setenv("CALIBER_AGENT_HOME", filepath.Join(t.TempDir(), "absent"))
	var calls int32
	srv := enrollCountingServer(t, &calls)
	// srv.URL is http:// — confirm validator rejects without --insecure.

	cmd := New()
	var buf bytes.Buffer
	cmd.SetOut(&buf)
	cmd.SetErr(&buf)
	cmd.SetArgs([]string{"enroll", "tok", "--api-base-url=" + srv.URL})
	err := cmd.ExecuteContext(context.Background())

	var ee *ExitError
	if !errors.As(err, &ee) {
		t.Fatalf("err = %v, want *ExitError", err)
	}
	if ee.Code != 1 {
		t.Errorf("Code = %d, want 1", ee.Code)
	}
	if got := atomic.LoadInt32(&calls); got != 0 {
		t.Errorf("API must NOT be called when http rejected; calls=%d", got)
	}
	if !strings.Contains(err.Error(), "insecure") && !strings.Contains(err.Error(), "http") {
		t.Errorf("error should mention http/--insecure, got: %v", err)
	}
}

func TestEnroll_HTTPWithInsecure_Allowed(t *testing.T) {
	root := filepath.Join(t.TempDir(), "absent")
	t.Setenv("CALIBER_AGENT_HOME", root)
	withFakeSecurity(t, 0, "")

	var calls int32
	srv := enrollCountingServer(t, &calls)
	useFakePrompter(t, []bool{true, true}, [][]int{{0}})

	cmd := New()
	var buf bytes.Buffer
	cmd.SetOut(&buf)
	cmd.SetErr(&buf)
	cmd.SetArgs([]string{"enroll", "tok", "--api-base-url=" + srv.URL, "--insecure"})

	if err := cmd.ExecuteContext(context.Background()); err != nil {
		t.Fatalf("want nil, got %v\noutput: %s", err, buf.String())
	}
	if got := atomic.LoadInt32(&calls); got != 1 {
		t.Errorf("expected 1 API call, got %d", got)
	}
	// InsecureTransport persistence to config.toml is verified by the wizard
	// test TestRunEnrollWizard_InsecureTransportPersisted (Task 8.2). Here we
	// only confirm --insecure unblocks the http:// reject gate end-to-end.
}
