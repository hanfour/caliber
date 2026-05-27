package cli

import (
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
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

// Note: TestStatus_DoesNotMakeNetworkRequests + TestStatusJSON_DoesNotMakeNetworkRequests
// live in privacy_regression_test.go alongside the other subcommand privacy
// guards (pause/resume/add-path/remove-path). Keeping them together makes
// the contract self-documenting: any future runtime subcommand that wants
// to add network IO must explicitly carve itself out of the shared assert.
