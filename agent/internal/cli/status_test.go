package cli

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/hanfour/ai-dev-eval/agent/internal/config"
)

// TestStatus_HappyPath_Human: enrolled root + default flags → human-readable
// output containing the field labels documented in spec §3.5.
func TestStatus_HappyPath_Human(t *testing.T) {
	setupEnrolledRoot(t)
	stdout := executeCLIStdout(t, []string{"status"})
	for _, want := range []string{
		"caliber-agent",
		"device_id:",
		"api_base_url:",
		"mode:",
		"paused:",
		"watched paths",
	} {
		if !strings.Contains(stdout, want) {
			t.Errorf("missing %q in output:\n%s", want, stdout)
		}
	}
	// device_id from setupEnrolledRoot's seeded config must be present.
	if !strings.Contains(stdout, "dev-abc") {
		t.Errorf("missing device_id value in output:\n%s", stdout)
	}
}

// TestStatus_JSON_StructuredOutput: --json emits a parseable object with
// the schema documented in spec §3.5.
func TestStatus_JSON_StructuredOutput(t *testing.T) {
	setupEnrolledRoot(t)
	stdout := executeCLIStdout(t, []string{"status", "--json"})
	var got map[string]any
	if err := json.Unmarshal([]byte(stdout), &got); err != nil {
		t.Fatalf("json parse: %v\noutput=%s", err, stdout)
	}
	for _, key := range []string{
		"version",
		"device_id",
		"api_base_url",
		"insecure_transport",
		"mode",
		"paused",
		"watched_paths",
		"files_tracked",
	} {
		if _, ok := got[key]; !ok {
			t.Errorf("missing key %q in JSON output: %v", key, got)
		}
	}
	if got["device_id"] != "dev-abc" {
		t.Errorf("device_id = %v, want dev-abc", got["device_id"])
	}
	if got["paused"] != false {
		t.Errorf("paused = %v, want false", got["paused"])
	}
}

// TestStatus_NotEnrolled_Exit1: no config.toml → exit 1.
func TestStatus_NotEnrolled_Exit1(t *testing.T) {
	t.Setenv("CALIBER_AGENT_HOME", filepath.Join(t.TempDir(), "no-such"))
	code := executeCLI(t, []string{"status"})
	if code != 1 {
		t.Fatalf("want 1, got %d", code)
	}
}

// TestStatus_DoesNotMakeNetworkRequests: spec §3.5 explicitly guarantees
// zero network IO. Point api_base_url at an httptest server and assert the
// handler is never invoked.
func TestStatus_DoesNotMakeNetworkRequests(t *testing.T) {
	setupEnrolledRoot(t)
	var hits int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		atomic.AddInt32(&hits, 1)
	}))
	t.Cleanup(srv.Close)

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("load config: %v", err)
	}
	cfg.APIBaseURL = srv.URL
	if err := config.SaveConfig(cfg); err != nil {
		t.Fatalf("save config: %v", err)
	}

	// Run both shapes — neither must hit the server.
	executeCLI(t, []string{"status"})
	executeCLI(t, []string{"status", "--json"})

	if got := atomic.LoadInt32(&hits); got != 0 {
		t.Fatalf("status must NOT make HTTP requests, got %d hits", got)
	}
}
