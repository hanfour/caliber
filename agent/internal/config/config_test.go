package config

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestLoadMissingReturnsErrNotEnrolled(t *testing.T) {
	t.Setenv("CALIBER_AGENT_HOME", t.TempDir())
	_, err := Load()
	if !errors.Is(err, ErrNotEnrolled) {
		t.Fatalf("err = %v, want ErrNotEnrolled", err)
	}
}

func TestSaveThenLoadRoundTrip(t *testing.T) {
	tmp := filepath.Join(t.TempDir(), "fresh")
	t.Setenv("CALIBER_AGENT_HOME", tmp)

	c := &Config{
		DeviceID:     "dev-abc",
		Hostname:     "h4",
		OS:           "darwin 25.3.0",
		APIBaseURL:   "https://caliber.local",
		Mode:         "metadata-only",
		IncludePaths: []string{},
	}
	if err := SaveConfigInitial(c); err != nil {
		t.Fatalf("SaveConfigInitial: %v", err)
	}

	info, err := os.Stat(filepath.Join(tmp, "config.toml"))
	if err != nil {
		t.Fatalf("Stat: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Errorf("perm = %o, want 0600", perm)
	}

	got, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if got.DeviceID != c.DeviceID || got.APIBaseURL != c.APIBaseURL {
		t.Errorf("round-trip mismatch: got %+v, want %+v", got, c)
	}
	if got.IncludePaths == nil {
		t.Error("IncludePaths should be empty slice, not nil")
	}
	if len(got.IncludePaths) != 0 {
		t.Errorf("IncludePaths = %v, want empty", got.IncludePaths)
	}
}

func TestSaveThenLoadRoundTrip_KeychainPath(t *testing.T) {
	tmp := filepath.Join(t.TempDir(), "fresh")
	t.Setenv("CALIBER_AGENT_HOME", tmp)

	c := &Config{
		DeviceID:     "dev-abc",
		Mode:         "metadata-only",
		IncludePaths: []string{},
		KeychainPath: "/Users/h/.caliber-agent/caliber.keychain-db",
	}
	if err := SaveConfigInitial(c); err != nil {
		t.Fatalf("SaveConfigInitial: %v", err)
	}
	got, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if got.KeychainPath != c.KeychainPath {
		t.Errorf("KeychainPath round-trip: got %q, want %q", got.KeychainPath, c.KeychainPath)
	}
}

// Empty KeychainPath must omit the key entirely (omitempty) so existing
// login-keychain configs round-trip unchanged.
func TestSaveThenLoadRoundTrip_KeychainPathEmptyOmitted(t *testing.T) {
	tmp := filepath.Join(t.TempDir(), "fresh")
	t.Setenv("CALIBER_AGENT_HOME", tmp)
	if err := SaveConfigInitial(&Config{DeviceID: "x", IncludePaths: []string{}}); err != nil {
		t.Fatalf("SaveConfigInitial: %v", err)
	}
	raw, err := os.ReadFile(filepath.Join(tmp, "config.toml"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "keychain_path") {
		t.Errorf("empty KeychainPath should be omitted; config.toml = %s", raw)
	}
	got, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if got.KeychainPath != "" {
		t.Errorf("KeychainPath = %q, want empty", got.KeychainPath)
	}
}

func TestSaveIsAtomic(t *testing.T) {
	tmp := filepath.Join(t.TempDir(), "fresh")
	t.Setenv("CALIBER_AGENT_HOME", tmp)
	if err := SaveConfigInitial(&Config{DeviceID: "x"}); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(tmp)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if filepath.Ext(e.Name()) == ".tmp" {
			t.Errorf("leftover tmp file: %s", e.Name())
		}
	}
}

func TestSaveCreatesParentDir(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("CALIBER_AGENT_HOME", filepath.Join(tmp, "nested", "deep"))
	if err := SaveConfigInitial(&Config{DeviceID: "x"}); err != nil {
		t.Fatalf("SaveConfigInitial: %v", err)
	}
	if _, err := os.Stat(filepath.Join(tmp, "nested", "deep", "config.toml")); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			t.Fatal("config file was not created in nested dir")
		}
		t.Fatal(err)
	}
}

func TestLoadMalformedTOML(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("CALIBER_AGENT_HOME", tmp)
	// Write invalid TOML
	if err := os.WriteFile(filepath.Join(tmp, "config.toml"), []byte("not = [valid toml"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err := Load()
	if err == nil {
		t.Fatal("expected error for malformed TOML, got nil")
	}
}

func TestSaveNilIncludePaths(t *testing.T) {
	tmp := filepath.Join(t.TempDir(), "fresh")
	t.Setenv("CALIBER_AGENT_HOME", tmp)
	// Save with nil IncludePaths — should be coerced to empty slice
	if err := SaveConfigInitial(&Config{DeviceID: "y", IncludePaths: nil}); err != nil {
		t.Fatalf("SaveConfigInitial: %v", err)
	}
	got, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if got.IncludePaths == nil {
		t.Error("IncludePaths should be non-nil after Save+Load of nil")
	}
}

func TestSaveConfigInitial_CreatesDirWhenAbsent(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "fresh-root")
	t.Setenv("CALIBER_AGENT_HOME", dir)
	cfg := &Config{DeviceID: "d_x", APIBaseURL: "https://x"}
	if err := SaveConfigInitial(cfg); err != nil {
		t.Fatalf("want nil, got %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "config.toml")); err != nil {
		t.Fatalf("config.toml must exist, got %v", err)
	}
}

func TestSaveConfigInitial_SentinelPresent_Rejects(t *testing.T) {
	root := setupRoot(t)
	_ = os.WriteFile(filepath.Join(root, "config.toml"), []byte(""), 0o600)
	_ = os.WriteFile(filepath.Join(root, ".uninstalling"), []byte(""), 0o600)
	cfg := &Config{DeviceID: "d_x", APIBaseURL: "https://x"}
	if err := SaveConfigInitial(cfg); !errors.Is(err, ErrUninstallInProgress) {
		t.Fatalf("want ErrUninstallInProgress, got %v", err)
	}
}

func TestSaveConfigInitial_RootExistsConfigMissing_ErrPartialUninstall(t *testing.T) {
	setupRoot(t) // root exists; no config.toml, no sentinel
	cfg := &Config{DeviceID: "d_x", APIBaseURL: "https://x"}
	if err := SaveConfigInitial(cfg); !errors.Is(err, ErrPartialUninstall) {
		t.Fatalf("want ErrPartialUninstall, got %v", err)
	}
}

func TestSaveConfigInitial_RootIsFileNotDir_Error(t *testing.T) {
	dir := t.TempDir()
	rootPath := filepath.Join(dir, "ca-as-file")
	if err := os.WriteFile(rootPath, []byte("oops"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CALIBER_AGENT_HOME", rootPath)
	cfg := &Config{DeviceID: "d_x", APIBaseURL: "https://x"}
	if err := SaveConfigInitial(cfg); err == nil || errors.Is(err, ErrUninstallInProgress) {
		t.Fatalf("want generic error, got %v", err)
	}
}

func TestSaveConfig_Runtime_RefusesWhenSentinelPresent(t *testing.T) {
	root := setupRoot(t)
	_ = os.WriteFile(filepath.Join(root, "config.toml"), []byte(""), 0o600)
	_ = os.WriteFile(filepath.Join(root, ".uninstalling"), []byte(""), 0o600)
	cfg := &Config{DeviceID: "d_x", APIBaseURL: "https://x"}
	if err := SaveConfig(cfg); !errors.Is(err, ErrUninstallInProgress) {
		t.Fatalf("want ErrUninstallInProgress, got %v", err)
	}
}

func TestSaveConfig_Runtime_RefusesWhenRootMissing(t *testing.T) {
	t.Setenv("CALIBER_AGENT_HOME", filepath.Join(t.TempDir(), "absent"))
	cfg := &Config{DeviceID: "d_x", APIBaseURL: "https://x"}
	if err := SaveConfig(cfg); !errors.Is(err, ErrRootRemoved) {
		t.Fatalf("want ErrRootRemoved, got %v", err)
	}
}

func TestValidateAPIBaseURL_AcceptsHTTPS(t *testing.T) {
	if err := ValidateAPIBaseURL("https://caliber.example/", false); err != nil {
		t.Fatalf("want nil, got %v", err)
	}
}

func TestValidateAPIBaseURL_RejectsHTTPWithoutInsecure(t *testing.T) {
	if err := ValidateAPIBaseURL("http://localhost:3001/", false); err == nil {
		t.Fatalf("want error, got nil")
	}
}

func TestValidateAPIBaseURL_AcceptsHTTPWithInsecure(t *testing.T) {
	if err := ValidateAPIBaseURL("http://localhost:3001/", true); err != nil {
		t.Fatalf("want nil, got %v", err)
	}
}

func TestValidateAPIBaseURL_RejectsOtherSchemes(t *testing.T) {
	for _, raw := range []string{"ftp://x/", "file:///etc/passwd", "gopher://x"} {
		if err := ValidateAPIBaseURL(raw, true); err == nil {
			t.Errorf("scheme in %q must be rejected even with --insecure", raw)
		}
	}
}

func TestValidateAPIBaseURL_RejectsMalformed(t *testing.T) {
	for _, raw := range []string{"", "://no-scheme", "https://", "not a url"} {
		if err := ValidateAPIBaseURL(raw, false); err == nil {
			t.Errorf("malformed %q must be rejected", raw)
		}
	}
}

func TestConfig_InsecureTransport_RoundTrip(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "fresh")
	t.Setenv("CALIBER_AGENT_HOME", dir)
	in := &Config{DeviceID: "d_x", APIBaseURL: "http://x", InsecureTransport: true}
	if err := SaveConfigInitial(in); err != nil {
		t.Fatalf("save: %v", err)
	}
	out, err := Load()
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if !out.InsecureTransport {
		t.Fatalf("InsecureTransport must round-trip as true, got %+v", out)
	}
}

// #6: BackfillCutoff is a fixed anchor persisted at enroll. TOML round-trips
// RFC3339 timestamps natively; this asserts a non-zero cutoff survives a
// save+load cycle unchanged (to the second — TOML's datetime type is precise
// enough for this, but we truncate to avoid any monotonic-reading component
// on the in-memory time.Time tripping up an exact Equal comparison).
func TestConfig_BackfillCutoff_RoundTrip(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "fresh")
	t.Setenv("CALIBER_AGENT_HOME", dir)

	cutoff := time.Date(2026, 4, 4, 12, 30, 0, 0, time.UTC)
	in := &Config{DeviceID: "d_x", APIBaseURL: "https://x", BackfillCutoff: cutoff}
	if err := SaveConfigInitial(in); err != nil {
		t.Fatalf("save: %v", err)
	}
	out, err := Load()
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if !out.BackfillCutoff.Equal(cutoff) {
		t.Fatalf("BackfillCutoff round-trip: got %v, want %v", out.BackfillCutoff, cutoff)
	}
}

// Zero BackfillCutoff (legacy enroll, or --backfill-days 0) must be omitted
// from the written TOML entirely, mirroring the KeychainPath omitempty
// contract above, so old configs keep parsing as "filter disabled".
func TestConfig_BackfillCutoff_ZeroOmitted(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "fresh")
	t.Setenv("CALIBER_AGENT_HOME", dir)
	if err := SaveConfigInitial(&Config{DeviceID: "x", IncludePaths: []string{}}); err != nil {
		t.Fatalf("SaveConfigInitial: %v", err)
	}
	raw, err := os.ReadFile(filepath.Join(dir, "config.toml"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "backfill_cutoff") {
		t.Errorf("zero BackfillCutoff should be omitted; config.toml = %s", raw)
	}
	got, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if !got.BackfillCutoff.IsZero() {
		t.Errorf("BackfillCutoff = %v, want zero", got.BackfillCutoff)
	}
}

func TestConfig_LoadOldFormat_DefaultsInsecureFalse(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "fresh")
	t.Setenv("CALIBER_AGENT_HOME", dir)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	// Synthesise pre-PR4 config.toml (no insecure_transport key).
	payload := "device_id = \"d_x\"\napi_base_url = \"https://x\"\nhostname = \"h\"\nos = \"darwin arm64\"\nmode = \"metadata-only\"\ninclude_paths = []\n"
	if err := os.WriteFile(filepath.Join(dir, "config.toml"), []byte(payload), 0o600); err != nil {
		t.Fatal(err)
	}
	out, err := Load()
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if out.InsecureTransport {
		t.Fatalf("missing field must default to false, got %+v", out)
	}
}
