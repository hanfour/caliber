package wizard

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/hanfour/ai-dev-eval/agent/internal/api"
	"github.com/hanfour/ai-dev-eval/agent/internal/config"
)

func TestRunEnrollWizard_HappyPathNoPaths(t *testing.T) {
	// SaveConfigInitial's first-write-aware precheck rejects root-exists +
	// config.toml-missing (treats it as a partial uninstall). Tests that
	// drive the first-write path must point at an absent root.
	t.Setenv("CALIBER_AGENT_HOME", filepath.Join(t.TempDir(), "absent"))

	fp := NewFakePrompter()
	fp.Answers.Confirms = []bool{true, true} // "begin?" yes, "confirm config" yes
	fp.Answers.Selections = [][]int{{}}      // user picks "none"

	var enrolledWith api.EnrollRequest
	var setSecretCalled bool
	deps := Deps{
		Prompter: fp,
		Scan:     func(string) ([]ProjectCandidate, error) { return nil, nil },
		Enroll: func(ctx context.Context, req api.EnrollRequest) (*api.EnrollResponse, error) {
			enrolledWith = req
			return &api.EnrollResponse{DeviceID: "d-1", Key: "cda_secret", KeyPrefix: "cda_xxxx"}, nil
		},
		SetSecret: func(account, secret string) error {
			setSecretCalled = true
			if account != "d-1" || secret != "cda_secret" {
				t.Errorf("SetSecret args wrong: %q / %q", account, secret)
			}
			return nil
		},
		Hostname:     "h4",
		OS:           "darwin 25.3.0",
		AgentVersion: "dev",
		APIBaseURL:   "http://localhost:3001",
	}
	if err := RunEnrollWizard(context.Background(), deps, "some-enroll-token"); err != nil {
		t.Fatalf("RunEnrollWizard: %v", err)
	}
	if !setSecretCalled {
		t.Error("SetSecret was not called")
	}
	if enrolledWith.Token != "some-enroll-token" || enrolledWith.Hostname != "h4" {
		t.Errorf("Enroll called with %+v", enrolledWith)
	}

	got, err := config.Load()
	if err != nil {
		t.Fatalf("config.Load: %v", err)
	}
	if got.DeviceID != "d-1" {
		t.Errorf("DeviceID = %q", got.DeviceID)
	}
	if len(got.IncludePaths) != 0 {
		t.Errorf("IncludePaths = %v, want empty (privacy default)", got.IncludePaths)
	}
}

// #168: Deps.KeychainPath must be persisted into config.toml so that
// `run` / `uninstall` reuse the same custom keychain the operator enrolled
// against without re-passing --keychain.
func TestRunEnrollWizard_PersistsKeychainPath(t *testing.T) {
	t.Setenv("CALIBER_AGENT_HOME", filepath.Join(t.TempDir(), "absent"))
	fp := NewFakePrompter()
	fp.Answers.Confirms = []bool{true, true}
	fp.Answers.Selections = [][]int{{}}
	deps := Deps{
		Prompter: fp,
		Scan:     func(string) ([]ProjectCandidate, error) { return nil, nil },
		Enroll: func(_ context.Context, _ api.EnrollRequest) (*api.EnrollResponse, error) {
			return &api.EnrollResponse{DeviceID: "d-1", Key: "cda_secret", KeyPrefix: "cda_xxxx"}, nil
		},
		SetSecret:    func(_, _ string) error { return nil },
		Hostname:     "h4",
		OS:           "darwin",
		AgentVersion: "dev",
		APIBaseURL:   "http://localhost:3001",
		KeychainPath: "/Users/h/.caliber-agent/caliber.keychain-db",
	}
	if err := RunEnrollWizard(context.Background(), deps, "tok"); err != nil {
		t.Fatalf("RunEnrollWizard: %v", err)
	}
	got, err := config.Load()
	if err != nil {
		t.Fatalf("config.Load: %v", err)
	}
	if got.KeychainPath != deps.KeychainPath {
		t.Errorf("KeychainPath = %q, want %q", got.KeychainPath, deps.KeychainPath)
	}
}

func TestRunEnrollWizard_TokenInvalid(t *testing.T) {
	t.Setenv("CALIBER_AGENT_HOME", t.TempDir())
	fp := NewFakePrompter()
	fp.Answers.Confirms = []bool{true}
	deps := Deps{
		Prompter: fp,
		Scan:     func(string) ([]ProjectCandidate, error) { return nil, nil },
		Enroll: func(_ context.Context, _ api.EnrollRequest) (*api.EnrollResponse, error) {
			return nil, &api.APIError{StatusCode: 401, ErrorTag: "invalid_token"}
		},
		SetSecret: func(_, _ string) error {
			t.Fatal("SetSecret must NOT be called on 401")
			return nil
		},
	}
	err := RunEnrollWizard(context.Background(), deps, "bad")
	if !errors.Is(err, api.ErrInvalidToken) {
		t.Fatalf("err = %v, want ErrInvalidToken", err)
	}
	if _, lerr := config.Load(); !errors.Is(lerr, config.ErrNotEnrolled) {
		t.Errorf("config should not exist after 401, got: %v", lerr)
	}
}

func TestRunEnrollWizard_KeychainFailsAfterAPI(t *testing.T) {
	t.Setenv("CALIBER_AGENT_HOME", t.TempDir())
	fp := NewFakePrompter()
	fp.Answers.Confirms = []bool{true}
	deps := Deps{
		Prompter: fp,
		Scan:     func(string) ([]ProjectCandidate, error) { return nil, nil },
		Enroll: func(_ context.Context, _ api.EnrollRequest) (*api.EnrollResponse, error) {
			return &api.EnrollResponse{DeviceID: "d-X", Key: "cda_lost_secret"}, nil
		},
		SetSecret: func(_, _ string) error { return errors.New("keychain: permission denied") },
	}
	err := RunEnrollWizard(context.Background(), deps, "t")
	if err == nil {
		t.Fatal("expected error when SetSecret fails")
	}
	var lk *LostKeyError
	if !errors.As(err, &lk) {
		t.Fatalf("err = %v, want *LostKeyError chain", err)
	}
	if lk.RawKey != "cda_lost_secret" || lk.DeviceID != "d-X" {
		t.Errorf("LostKeyError = %+v", lk)
	}
	if _, lerr := config.Load(); !errors.Is(lerr, config.ErrNotEnrolled) {
		t.Errorf("config must not be written on Failure C, got: %v", lerr)
	}
}

func TestRunEnrollWizard_UserCancelsInitialConfirm(t *testing.T) {
	t.Setenv("CALIBER_AGENT_HOME", t.TempDir())
	fp := NewFakePrompter()
	fp.Answers.Confirms = []bool{false} // user declines at first confirm
	deps := Deps{
		Prompter: fp,
		Scan:     func(string) ([]ProjectCandidate, error) { return nil, nil },
		Enroll: func(_ context.Context, _ api.EnrollRequest) (*api.EnrollResponse, error) {
			t.Fatal("Enroll must NOT be called when user declines at initial confirm")
			return nil, nil
		},
		SetSecret: func(_, _ string) error {
			t.Fatal("SetSecret must NOT be called")
			return nil
		},
	}
	err := RunEnrollWizard(context.Background(), deps, "t")
	if err == nil {
		t.Fatal("expected cancellation error")
	}
	if !strings.Contains(err.Error(), "cancelled") {
		t.Errorf("err = %v, want 'cancelled by user'", err)
	}
	if _, lerr := config.Load(); !errors.Is(lerr, config.ErrNotEnrolled) {
		t.Errorf("config must not exist after cancel, got: %v", lerr)
	}
}

func TestRunEnrollWizard_UserCancelsFinalConfirm_KeepsKeychainAndInitialConfig(t *testing.T) {
	t.Setenv("CALIBER_AGENT_HOME", filepath.Join(t.TempDir(), "absent"))
	fp := NewFakePrompter()
	fp.Answers.Confirms = []bool{true, false} // begin yes, final-save no
	fp.Answers.Selections = [][]int{{0}}      // pick "None"
	deps := Deps{
		Prompter: fp,
		Scan:     func(string) ([]ProjectCandidate, error) { return nil, nil },
		Enroll: func(_ context.Context, _ api.EnrollRequest) (*api.EnrollResponse, error) {
			return &api.EnrollResponse{DeviceID: "d-2", Key: "cda_s", KeyPrefix: "cda_"}, nil
		},
		SetSecret: func(_, _ string) error { return nil },
	}
	err := RunEnrollWizard(context.Background(), deps, "t")
	if err != nil {
		t.Fatalf("RunEnrollWizard: %v", err)
	}
	// Config from step-4 initial save must still exist with empty include_paths.
	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("config.Load: %v", err)
	}
	if cfg.DeviceID != "d-2" {
		t.Errorf("DeviceID = %q, initial config should have been written before final-confirm gate", cfg.DeviceID)
	}
	if len(cfg.IncludePaths) != 0 {
		t.Errorf("IncludePaths should be empty, got %v", cfg.IncludePaths)
	}
}

// #6: BackfillDays > 0 must set a fixed cutoff (now - N days) on the
// persisted config. The cutoff is an anchor, not rolling, so we only assert
// it lands within a tight window around the expected value rather than an
// exact time.Now() match (RunEnrollWizard calls time.Now() internally, a few
// microseconds after this test computes its own "now").
func TestRunEnrollWizard_BackfillDaysSetsCutoff(t *testing.T) {
	root := filepath.Join(t.TempDir(), "absent")
	t.Setenv("CALIBER_AGENT_HOME", root)

	fp := NewFakePrompter()
	fp.Answers.Confirms = []bool{true, true}
	fp.Answers.Selections = [][]int{{0}}
	deps := happyDeps(fp, nil)
	deps.BackfillDays = 90

	before := time.Now().AddDate(0, 0, -90)
	if err := RunEnrollWizard(context.Background(), deps, "tok"); err != nil {
		t.Fatal(err)
	}
	after := time.Now().AddDate(0, 0, -90)

	cfg, err := config.Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.BackfillCutoff.Before(before.Add(-time.Second)) || cfg.BackfillCutoff.After(after.Add(time.Second)) {
		t.Fatalf("BackfillCutoff = %v, want within [%v, %v]", cfg.BackfillCutoff, before, after)
	}
}

// BackfillDays == 0 (explicit --backfill-days 0, or the zero value) must
// leave BackfillCutoff zero — disabling the filter entirely, not "0 days
// before now" which would skip everything.
func TestRunEnrollWizard_BackfillDaysZero_LeavesCutoffZero(t *testing.T) {
	root := filepath.Join(t.TempDir(), "absent")
	t.Setenv("CALIBER_AGENT_HOME", root)

	fp := NewFakePrompter()
	fp.Answers.Confirms = []bool{true, true}
	fp.Answers.Selections = [][]int{{0}}
	deps := happyDeps(fp, nil)
	deps.BackfillDays = 0

	if err := RunEnrollWizard(context.Background(), deps, "tok"); err != nil {
		t.Fatal(err)
	}
	cfg, err := config.Load()
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.BackfillCutoff.IsZero() {
		t.Fatalf("BackfillCutoff = %v, want zero", cfg.BackfillCutoff)
	}
}

func TestLostKeyErrorImplementsErrorAndUnwrap(t *testing.T) {
	cause := errors.New("disk full")
	lk := &LostKeyError{DeviceID: "d-1", RawKey: "cda_x", Cause: cause}
	if !strings.Contains(lk.Error(), "disk full") {
		t.Errorf("Error() = %q, missing cause text", lk.Error())
	}
	if !errors.Is(lk, cause) {
		t.Errorf("errors.Is should find the wrapped cause")
	}
}

// happyDeps returns a Deps wired with a success-shaped Enroll, a no-op
// SetSecret, and a Scan stub. The caller supplies the Prompter so each test
// can script its own answers. Used by the Phase 8.2 wizard tests.
func happyDeps(prompter Prompter, cands []ProjectCandidate) Deps {
	return Deps{
		Prompter: prompter,
		Scan:     func(string) ([]ProjectCandidate, error) { return cands, nil },
		Enroll: func(_ context.Context, _ api.EnrollRequest) (*api.EnrollResponse, error) {
			return &api.EnrollResponse{DeviceID: "d-8", Key: "cda_p8", KeyPrefix: "cda_"}, nil
		},
		SetSecret:    func(_, _ string) error { return nil },
		Hostname:     "h",
		OS:           "darwin",
		AgentVersion: "dev",
		APIBaseURL:   "https://api.example",
	}
}

func TestRunEnrollWizard_FirstWriteUsesSaveConfigInitial(t *testing.T) {
	// Point CALIBER_AGENT_HOME at a NOT-YET-CREATED path. SaveConfigInitial
	// must MkdirAll the root and write config.toml in one shot — the contract
	// the wizard relies on for first-enroll.
	root := filepath.Join(t.TempDir(), "absent")
	t.Setenv("CALIBER_AGENT_HOME", root)

	fp := NewFakePrompter()
	fp.Answers.Confirms = []bool{true, true}
	fp.Answers.Selections = [][]int{{0}} // "None"
	deps := happyDeps(fp, nil)

	if err := RunEnrollWizard(context.Background(), deps, "tok"); err != nil {
		t.Fatalf("RunEnrollWizard: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "config.toml")); err != nil {
		t.Fatalf("config.toml expected under absent root, %v", err)
	}
}

func TestRunEnrollWizard_IncludePathsNormalised(t *testing.T) {
	root := filepath.Join(t.TempDir(), "absent")
	t.Setenv("CALIBER_AGENT_HOME", root)

	// Build a symlink: linkParent/code -> target. Tests assert the wizard
	// persists `target` (resolved) instead of `via` (symlinked path).
	target := t.TempDir()
	// EvalSymlinks on macOS returns the canonical path through /private/tmp;
	// resolve the expected value the same way to keep the assertion portable.
	resolvedTarget, err := filepath.EvalSymlinks(target)
	if err != nil {
		t.Fatal(err)
	}
	linkParent := t.TempDir()
	via := filepath.Join(linkParent, "code")
	if err := os.Symlink(target, via); err != nil {
		t.Fatal(err)
	}

	// Inject a Scan stub that returns the symlinked path as the candidate;
	// the prompter picks index 1 (the only non-"None" option).
	cands := []ProjectCandidate{{CWD: via}}
	fp := NewFakePrompter()
	fp.Answers.Confirms = []bool{true, true}
	fp.Answers.Selections = [][]int{{1}}
	deps := happyDeps(fp, cands)

	if err := RunEnrollWizard(context.Background(), deps, "tok"); err != nil {
		t.Fatalf("RunEnrollWizard: %v", err)
	}
	cfg, err := config.Load()
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg.IncludePaths) != 1 {
		t.Fatalf("IncludePaths len = %d, want 1; got %v", len(cfg.IncludePaths), cfg.IncludePaths)
	}
	if cfg.IncludePaths[0] != resolvedTarget {
		t.Fatalf("IncludePaths[0] = %q, want EvalSymlinks-normalised %q (via %q)",
			cfg.IncludePaths[0], resolvedTarget, via)
	}
}

func TestRunEnrollWizard_IncludePathsBrokenSymlinkSkipped(t *testing.T) {
	root := filepath.Join(t.TempDir(), "absent")
	t.Setenv("CALIBER_AGENT_HOME", root)

	// Real path: kept. Broken symlink (target deleted): dropped with a stderr
	// warning ("warning: skipping ... (cannot resolve: ...)"). We don't assert
	// the warning text here — verifying the path is excluded from the persisted
	// config is sufficient for behavioural coverage, and capturing os.Stderr
	// would complicate the test for marginal benefit.
	good := t.TempDir()
	resolvedGood, err := filepath.EvalSymlinks(good)
	if err != nil {
		t.Fatal(err)
	}
	dead := t.TempDir()
	linkParent := t.TempDir()
	brokenLink := filepath.Join(linkParent, "broken")
	if err := os.Symlink(dead, brokenLink); err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(dead); err != nil {
		t.Fatal(err)
	}

	cands := []ProjectCandidate{{CWD: good}, {CWD: brokenLink}}
	fp := NewFakePrompter()
	fp.Answers.Confirms = []bool{true, true}
	fp.Answers.Selections = [][]int{{1, 2}} // pick both candidates (broken should drop)
	deps := happyDeps(fp, cands)

	if err := RunEnrollWizard(context.Background(), deps, "tok"); err != nil {
		t.Fatalf("RunEnrollWizard: %v", err)
	}
	cfg, err := config.Load()
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg.IncludePaths) != 1 || cfg.IncludePaths[0] != resolvedGood {
		t.Fatalf("expected only resolved good path %q, got %v", resolvedGood, cfg.IncludePaths)
	}
}

func TestRunEnrollWizard_InsecureTransportPersisted(t *testing.T) {
	root := filepath.Join(t.TempDir(), "absent")
	t.Setenv("CALIBER_AGENT_HOME", root)

	fp := NewFakePrompter()
	fp.Answers.Confirms = []bool{true, true}
	fp.Answers.Selections = [][]int{{0}}
	deps := happyDeps(fp, nil)
	deps.InsecureTransport = true

	if err := RunEnrollWizard(context.Background(), deps, "tok"); err != nil {
		t.Fatal(err)
	}
	cfg, err := config.Load()
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.InsecureTransport {
		t.Fatalf("InsecureTransport must persist (got cfg=%+v)", cfg)
	}
}
