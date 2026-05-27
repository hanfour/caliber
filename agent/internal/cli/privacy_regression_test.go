package cli

import (
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/hanfour/ai-dev-eval/agent/internal/config"
)

// Privacy regression — spec §3.5, §3.6, §3.7, §3.8 (PR4 design doc) and
// plan Phase 14.1 guarantee that runtime subcommands (status, pause, resume,
// add-path, remove-path) perform NO network IO. The user-trust contract is
// that ONLY `enroll`, `run`, and `uninstall --keep-remote=false` may speak
// to the API — every other subcommand must be observable as a hard-offline
// operation by anyone tcpdump'ing the loopback interface.
//
// To make that contract a test, we point `api_base_url` at an httptest server
// whose handler atomically flips a flag. Running the subcommand must leave
// the flag at zero. Any future regression that adds, say, a "ping the server
// to see if the daemon is up" call to `status` will trip this test.
//
// We use a shared helper to keep each subcommand's regression case to one
// line; the helper itself sets up an enrolled root, overrides the API base,
// runs the CLI, and asserts hits == 0.

func assertNoNetwork(t *testing.T, args []string) {
	t.Helper()
	var hits int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		atomic.AddInt32(&hits, 1)
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(srv.Close)

	setupEnrolledRoot(t)
	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("load config: %v", err)
	}
	cfg.APIBaseURL = srv.URL
	if err := config.SaveConfig(cfg); err != nil {
		t.Fatalf("save config: %v", err)
	}

	// Exit code is intentionally ignored — the contract under test is the
	// absence of network IO, not the exit code (which other tests cover).
	_ = executeCLI(t, args)

	if got := atomic.LoadInt32(&hits); got != 0 {
		t.Fatalf("subcommand %v must NOT make HTTP requests; got %d hits", args, got)
	}
}

func TestStatus_DoesNotMakeNetworkRequests(t *testing.T) {
	assertNoNetwork(t, []string{"status"})
}

func TestStatusJSON_DoesNotMakeNetworkRequests(t *testing.T) {
	assertNoNetwork(t, []string{"status", "--json"})
}

func TestPause_DoesNotMakeNetworkRequests(t *testing.T) {
	assertNoNetwork(t, []string{"pause"})
}

func TestResume_DoesNotMakeNetworkRequests(t *testing.T) {
	assertNoNetwork(t, []string{"resume"})
}

func TestAddPath_DoesNotMakeNetworkRequests(t *testing.T) {
	assertNoNetwork(t, []string{"add-path", t.TempDir(), "--yes"})
}

func TestRemovePath_DoesNotMakeNetworkRequests(t *testing.T) {
	assertNoNetwork(t, []string{"remove-path", t.TempDir()})
}
