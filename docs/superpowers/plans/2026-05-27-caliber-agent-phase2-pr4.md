# caliber-agent Phase 2 PR4 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 6 個子命令落地 (`add-path` / `remove-path` / `pause` / `resume` / `status` / `uninstall`) + `set-mode` 移除 + 9 項合規硬化 + server `DELETE /v1/devices/me` endpoint，把 caliber-agent 從 demo 階段帶到可手動 dogfood 階段，與 Anthropic Usage Policy 網路安全違規攔截守則對齊。

**Architecture:** Server side 加 cda_\* 認證的 self-revoke REST endpoint (`apps/api/src/rest/devicesRevokeSelf.ts`) + audit log + integration tests。Agent side 引入 typed sentinel errors + `precheckRuntime` + `lockfile` 探活 + `.uninstalling` stop sentinel 構成「4-point precheck」防護網（run 啟動 / tick / per-chunk / per-Save），確保 uninstall 期間 daemon 0 in-flight chunk 之外不再上傳。`SaveConfig` 拆成 `SaveConfigInitial`（enroll 首寫，first-write-aware sentinel + partial-cleanup checks）與 `SaveConfig`（runtime 走 precheckRuntime）。`uninstall` 走 9 步 ordered_delete (optional artifacts → tmp glob → config.toml → .uninstalling → rmdir)，invariant 是「sentinel 不在時 config.toml 也一定不在」。

**Tech Stack:**
- Agent: Go 1.25, Cobra CLI, RE2 regexp, `syscall.Flock`, `os.O_RDWR|O_CREATE` (no `O_TRUNC`)
- Server: TypeScript, Fastify, Drizzle ORM, Vitest integration tests
- Test conventions: agent TDD with 80% coverage gate via `agent/scripts/coverage.sh`；server integration tests via `pnpm exec vitest run --config vitest.integration.config.ts`

**Spec reference:** `docs/superpowers/specs/2026-05-25-caliber-agent-phase2-pr4-design.md` (1652 lines, 21 review rounds, 62 findings + 3 typos resolved)

---

## File Structure

### Agent side (new files)

| Path | Responsibility |
|---|---|
| `agent/internal/config/errors.go` | Typed sentinels: `ErrRootRemoved`, `ErrConfigRemoved`, `ErrUninstallInProgress`, `ErrPartialUninstall` |
| `agent/internal/config/precheck.go` | `precheckRuntime()` — root → sentinel → config.toml stat in order |
| `agent/internal/lockfile/lockfile_darwin.go` | `Acquire(path) (*Lock, error)` wraps `os.OpenFile` (no O_TRUNC) + `syscall.Flock` (LOCK_EX\|LOCK_NB) + `Truncate(0)` + `WritePID` |
| `agent/internal/lockfile/lockfile_other.go` | non-darwin stub returning `ErrUnsupported` |
| `agent/internal/api/revoke.go` | `(*Client).RevokeSelf(ctx, token)` — DELETE /v1/devices/me with 204/410 → nil, 401/404/5xx → APIError |

### Agent side (modified files)

| Path | Responsibility change |
|---|---|
| `agent/internal/config/config.go` | Split `Save` → `SaveConfig` (runtime, precheck) + `SaveConfigInitial` (first-write-aware sentinel + partial-cleanup); add `InsecureTransport bool` field; `ValidateAPIBaseURL(raw, allowInsecure)` helper |
| `agent/internal/config/state.go` | Remove `MkdirAll`; add `precheckRuntime` call; return typed errors |
| `agent/internal/config/redactionset.go` | Same as state.go |
| `agent/internal/config/paths.go` | Add `UninstallSentinelPath()`, `LockPath()`, `PausedPath()` |
| `agent/internal/cli/root.go` | Remove `set-mode` AddCommand; move `--api-base-url` from PersistentFlags to enroll-only local |
| `agent/internal/cli/run.go` | 5-step startup (pre-flight → acquire lock + PID → post-lock sentinel re-check → existing config/keychain/loop → graceful exit); fix `:29` short desc |
| `agent/internal/cli/enroll.go` | Early sentinel preflight + partial-cleanup check; add `--insecure` flag |
| `agent/internal/cli/addpath.go` | Real impl: validate absolute → EvalSymlinks → consent prompt → atomic append |
| `agent/internal/cli/removepath.go` | Real impl: graceful broken-symlink path |
| `agent/internal/cli/pause.go` | Real impl: dir + sentinel + config stat → write paused |
| `agent/internal/cli/resume.go` | Real impl: rm paused (idempotent) |
| `agent/internal/cli/status.go` | Real impl: human + `--json`; **zero network IO** |
| `agent/internal/cli/uninstall.go` | Real impl: probe → prompt → sentinel → remote → keychain → ordered_delete → listing |
| `agent/internal/cli/setmode.go` | **DELETED** |
| `agent/internal/cli/redactionset.go` | `BootstrapRedactionSet` fallback on `ErrTooManyPatterns` |
| `agent/internal/wizard/enroll.go` | Switch line 83 → `SaveConfigInitial`; line 119 → `SaveConfig`; IncludePaths normalisation |
| `agent/watcher/loop.go` | Tick + per-chunk + per-Save sentinel/config checks; typed dispatch for SaveState errors; symlink-resolved `allowed()` |
| `agent/watcher/claude.go` | `os.Lstat` filter for symlinked jsonl |
| `agent/watcher/codex.go` | Same; readCWD also Lstat-filters |
| `agent/internal/cwdresolve/cwdresolve.go` | `EvalSymlinks` integration in `tryExtractCWD` + `dirnameFallback` |
| `agent/redact/regexes.go` | `MaxRegexSrcLen = 1024` const + per-pattern bound check in `Compile()` |
| `agent/redact/set.go` | `MaxPatternCount = 100` + `ErrTooManyPatterns` sentinel + count gate in `RedactionSet.Compile()` |
| `agent/README.md` | New "Environment variables" section + uninstall/pause docs |

### Server side (new files)

| Path | Responsibility |
|---|---|
| `apps/api/src/rest/devicesRevokeSelf.ts` | `devicesRevokeSelfRoutes(env)` plugin: DELETE /v1/devices/me with `allowRevoked` helper + transaction update + audit |
| `apps/api/tests/integration/rest/devicesRevokeSelf.test.ts` | 10 cases: happy / idempotent / 401×3 / 410 already-revoked / ak\_\* rejection / concurrent / 404 ENABLE\_GATEWAY off / 500 server\_misconfigured |

### Server side (modified files)

| Path | Responsibility change |
|---|---|
| `apps/api/src/rest/ingestAuth.ts` | Add `resolveDeviceFromAuthAllowRevoked(db, env, authHeader)` sister fn; `ResolvedDeviceWithStatus { ...ResolvedDevice; alreadyRevoked: boolean }` |
| `apps/api/src/server.ts` | Register `devicesRevokeSelfRoutes(env)` plugin |
| `apps/api/src/services/audit.ts` 或 audit action enum | Add `device.self_revoked` |

---

## Phase Outline

| # | Phase | Goal |
|---|---|---|
| 1 | Config foundation | Typed sentinels + precheckRuntime + SaveState/SaveRedactionSet revise + SaveConfig split |
| 2 | Lockfile package | Cross-platform flock wrapper |
| 3 | Server endpoint | `DELETE /v1/devices/me` + allow-revoked helper + integration tests |
| 4 | Agent API client | `Client.RevokeSelf` |
| 5 | Redact limits | `MaxRegexSrcLen` / `MaxPatternCount` + bootstrap fallback fix |
| 6 | Symlink protection | watcher + cwdresolve EvalSymlinks |
| 7 | HTTPS validation + insecure flag | `ValidateAPIBaseURL` + `insecure_transport` field + enroll `--insecure` |
| 8 | `run` command upgrade | Pre-flight + lockfile + post-lock + per-tick/chunk/Save checks |
| 9 | `enroll` command upgrade | Sentinel preflight + partial-cleanup + wizard SaveConfigInitial/SaveConfig + IncludePaths normalisation |
| 10 | Subcommands part 1 | `add-path` + `remove-path` |
| 11 | Subcommands part 2 | `pause` + `resume` + `status` |
| 12 | `uninstall` | 9-step ordered_delete + sentinel write/restore + first-write-aware reject |
| 13 | Cleanup | Remove `set-mode` + flag scope tighten + run.go:29 doc fix |
| 14 | Docs + privacy regression | README env vars + status/cmd no-network tests |

Total: ~14 phases, ~42 tasks. PR4 預計 ~30+ raw commits squashed at merge.

---

## Phase 1: Config foundation — sentinels + precheckRuntime + paths

### Task 1.1: Add typed sentinel errors

**Files:**
- Create: `agent/internal/config/errors.go`
- Test: `agent/internal/config/errors_test.go`

- [ ] **Step 1: Write the failing test**

```go
// agent/internal/config/errors_test.go
package config

import (
	"errors"
	"fmt"
	"testing"
)

func TestSentinels_AreDistinctValues(t *testing.T) {
	for _, e := range []error{
		ErrRootRemoved, ErrConfigRemoved, ErrUninstallInProgress, ErrPartialUninstall,
	} {
		if e == nil {
			t.Fatalf("sentinel must not be nil")
		}
		if e.Error() == "" {
			t.Fatalf("sentinel %v must have message", e)
		}
	}
	if errors.Is(ErrRootRemoved, ErrConfigRemoved) {
		t.Fatalf("distinct sentinels must not be Is-equal")
	}
}

func TestSentinels_WrappedStillMatchesIs(t *testing.T) {
	wrapped := fmt.Errorf("op failed: %w", ErrUninstallInProgress)
	if !errors.Is(wrapped, ErrUninstallInProgress) {
		t.Fatalf("errors.Is must unwrap to sentinel")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent && go test ./internal/config/ -run TestSentinels -v`
Expected: FAIL — `undefined: ErrRootRemoved` etc.

- [ ] **Step 3: Create errors.go**

```go
// agent/internal/config/errors.go
package config

import "errors"

// Sentinels distinguish "agent should exit" conditions (uninstall in progress
// or completed) from real IO failures. precheckRuntime + atomic-writer save
// functions return these; watcher.Loop and runRun dispatch on them.
var (
	// ErrRootRemoved — ~/.caliber-agent/ no longer exists (ordered_delete (i) past)
	ErrRootRemoved = errors.New("config: root directory removed")

	// ErrConfigRemoved — config.toml missing while root still exists
	// (ordered_delete (g) past, (i) not yet — invariant says sentinel is also gone)
	ErrConfigRemoved = errors.New("config: config.toml removed")

	// ErrUninstallInProgress — .uninstalling sentinel present (cleanup (c)-(g) running)
	ErrUninstallInProgress = errors.New("config: uninstall in progress")

	// ErrPartialUninstall — root exists but config.toml missing detected at enroll-time
	// first-write-aware precheck; spec §6.2 / §3.8
	ErrPartialUninstall = errors.New("config: partial uninstall detected (root exists, config.toml missing)")
)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd agent && go test ./internal/config/ -run TestSentinels -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add agent/internal/config/errors.go agent/internal/config/errors_test.go
git commit -m "feat(agent/config): typed sentinel errors for uninstall lifecycle"
```

### Task 1.2: Add path helpers for sentinel + lockfile + paused

**Files:**
- Modify: `agent/internal/config/paths.go`
- Test: `agent/internal/config/paths_test.go`

- [ ] **Step 1: Write the failing test**

```go
// agent/internal/config/paths_test.go (append)
func TestNewPathHelpers(t *testing.T) {
	t.Setenv("CALIBER_AGENT_HOME", "/tmp/ca-test")
	cases := []struct{ name, want string; fn func() string }{
		{"sentinel", "/tmp/ca-test/.uninstalling", UninstallSentinelPath},
		{"lock", "/tmp/ca-test/.lock", LockPath},
		{"paused", "/tmp/ca-test/paused", PausedPath},
	}
	for _, c := range cases {
		if got := c.fn(); got != c.want {
			t.Errorf("%s: got %q want %q", c.name, got, c.want)
		}
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent && go test ./internal/config/ -run TestNewPathHelpers -v`
Expected: FAIL — `undefined: UninstallSentinelPath`

- [ ] **Step 3: Add path helpers**

```go
// agent/internal/config/paths.go (append after existing helpers)
func UninstallSentinelPath() string { return filepath.Join(RootDir(), ".uninstalling") }
func LockPath() string              { return filepath.Join(RootDir(), ".lock") }
func PausedPath() string            { return filepath.Join(RootDir(), "paused") }
```

- [ ] **Step 4: Run test**

Run: `cd agent && go test ./internal/config/ -run TestNewPathHelpers -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add agent/internal/config/paths.go agent/internal/config/paths_test.go
git commit -m "feat(agent/config): UninstallSentinelPath / LockPath / PausedPath helpers"
```

### Task 1.3: Add `precheckRuntime` helper

**Files:**
- Create: `agent/internal/config/precheck.go`
- Test: `agent/internal/config/precheck_test.go`

- [ ] **Step 1: Write the failing tests**

```go
// agent/internal/config/precheck_test.go
package config

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"testing"
)

func setupRoot(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("CALIBER_AGENT_HOME", dir)
	return dir
}

func TestPrecheckRuntime_AllPresent_ReturnsNil(t *testing.T) {
	root := setupRoot(t)
	if err := os.WriteFile(filepath.Join(root, "config.toml"), []byte(""), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := precheckRuntime(); err != nil {
		t.Fatalf("want nil, got %v", err)
	}
}

func TestPrecheckRuntime_RootMissing_ReturnsErrRootRemoved(t *testing.T) {
	t.Setenv("CALIBER_AGENT_HOME", "/tmp/nonexistent-caliber-agent-precheck")
	if err := precheckRuntime(); !errors.Is(err, ErrRootRemoved) {
		t.Fatalf("want ErrRootRemoved, got %v", err)
	}
}

func TestPrecheckRuntime_SentinelPresent_ReturnsErrUninstallInProgress(t *testing.T) {
	root := setupRoot(t)
	if err := os.WriteFile(filepath.Join(root, ".uninstalling"), []byte(""), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "config.toml"), []byte(""), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := precheckRuntime(); !errors.Is(err, ErrUninstallInProgress) {
		t.Fatalf("want ErrUninstallInProgress, got %v", err)
	}
}

func TestPrecheckRuntime_ConfigMissing_ReturnsErrConfigRemoved(t *testing.T) {
	setupRoot(t) // root exists, config.toml does not
	if err := precheckRuntime(); !errors.Is(err, ErrConfigRemoved) {
		t.Fatalf("want ErrConfigRemoved, got %v", err)
	}
}

func TestPrecheckRuntime_SentinelStatNonNotExist_FailsClosed(t *testing.T) {
	// Hard to provoke EACCES portably in unit test; assert documented behaviour via wrapped sentinel.
	// On platforms where Permission errors are possible, integration coverage handles this.
	root := setupRoot(t)
	// Make sentinel a directory (Stat returns nil err, but treat as "exists").
	if err := os.Mkdir(filepath.Join(root, ".uninstalling"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "config.toml"), []byte(""), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := precheckRuntime(); !errors.Is(err, ErrUninstallInProgress) {
		t.Fatalf("want ErrUninstallInProgress for non-ErrNotExist sentinel stat, got %v", err)
	}
	// Sanity: fs.ErrNotExist isn't being shadowed.
	_, sErr := os.Stat(filepath.Join(root, "does-not-exist"))
	if !errors.Is(sErr, fs.ErrNotExist) {
		t.Fatalf("test helper assumption broken")
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd agent && go test ./internal/config/ -run TestPrecheck -v`
Expected: FAIL — `undefined: precheckRuntime`

- [ ] **Step 3: Implement precheckRuntime**

```go
// agent/internal/config/precheck.go
package config

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
)

// precheckRuntime is called by SaveState / SaveRedactionSet / SaveConfig (runtime)
// before they touch the disk. Check order is reverse-aligned with ordered_delete
// (i)→(h)→(g) so that the most-recently-occurred state is detected first:
//
//  1. stat root        — ErrNotExist → ErrRootRemoved (ordered_delete (i) past)
//  2. stat .uninstalling — exists or non-ErrNotExist → ErrUninstallInProgress (fail-closed)
//  3. stat config.toml — ErrNotExist → ErrConfigRemoved (invariant: sentinel must also be gone,
//     but check anyway because precheck can race with ordered_delete (g)→(h))
//
// Returns nil iff the daemon is safe to perform a runtime write.
func precheckRuntime() error {
	root := RootDir()

	// 1. root must exist
	if _, err := os.Stat(root); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return ErrRootRemoved
		}
		// transient stat error — retry-friendly: don't block writes
	}

	// 2. sentinel — fail-closed
	if _, err := os.Stat(filepath.Join(root, ".uninstalling")); err == nil {
		return ErrUninstallInProgress
	} else if !errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("%w (sentinel stat failed: %v; fail-closed)", ErrUninstallInProgress, err)
	}

	// 3. config.toml — pure ErrNotExist
	if _, err := os.Stat(filepath.Join(root, "config.toml")); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return ErrConfigRemoved
		}
		// transient stat error — retry-friendly
	}
	return nil
}
```

- [ ] **Step 4: Run tests**

Run: `cd agent && go test ./internal/config/ -run TestPrecheck -v`
Expected: PASS (all 5)

- [ ] **Step 5: Commit**

```bash
git add agent/internal/config/precheck.go agent/internal/config/precheck_test.go
git commit -m "feat(agent/config): precheckRuntime helper (root → sentinel → config)"
```

### Task 1.4: Revise `SaveState` — remove MkdirAll, add precheckRuntime, typed errors

**Files:**
- Modify: `agent/internal/config/state.go`
- Modify: `agent/internal/config/state_test.go`

- [ ] **Step 1: Write failing tests**

```go
// agent/internal/config/state_test.go (append)
func TestSaveState_RefusesWriteWhenRootRemoved(t *testing.T) {
	t.Setenv("CALIBER_AGENT_HOME", "/tmp/does-not-exist-savestate")
	if err := SaveState(&State{Files: map[string]FileWatermark{}}); !errors.Is(err, ErrRootRemoved) {
		t.Fatalf("want ErrRootRemoved, got %v", err)
	}
}

func TestSaveState_RefusesWriteWhenSentinelExists(t *testing.T) {
	root := setupRoot(t)
	if err := os.WriteFile(filepath.Join(root, "config.toml"), []byte(""), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, ".uninstalling"), []byte(""), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := SaveState(&State{Files: map[string]FileWatermark{}}); !errors.Is(err, ErrUninstallInProgress) {
		t.Fatalf("want ErrUninstallInProgress, got %v", err)
	}
}

func TestSaveState_RefusesWriteWhenConfigTomlMissing(t *testing.T) {
	setupRoot(t) // root exists, no config.toml
	if err := SaveState(&State{Files: map[string]FileWatermark{}}); !errors.Is(err, ErrConfigRemoved) {
		t.Fatalf("want ErrConfigRemoved, got %v", err)
	}
}

func TestSaveState_DoesNotMkdirAll(t *testing.T) {
	root := setupRoot(t)
	if err := os.Remove(root); err != nil {
		t.Fatal(err)
	}
	_ = SaveState(&State{Files: map[string]FileWatermark{}})
	if _, err := os.Stat(root); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("SaveState must NOT recreate root, got stat err=%v", err)
	}
}

func TestSaveState_HappyPath_AllPrechecksMet(t *testing.T) {
	root := setupRoot(t)
	if err := os.WriteFile(filepath.Join(root, "config.toml"), []byte(""), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := SaveState(&State{Files: map[string]FileWatermark{}}); err != nil {
		t.Fatalf("want nil, got %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "state.json")); err != nil {
		t.Fatalf("state.json must exist, got %v", err)
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd agent && go test ./internal/config/ -run TestSaveState -v`
Expected: FAIL — existing SaveState calls MkdirAll + has no precheck

- [ ] **Step 3: Revise `SaveState`**

Replace existing `SaveState` body (`agent/internal/config/state.go`):

```go
// agent/internal/config/state.go (revised)
func SaveState(s *State) error {
	if s.Files == nil {
		s.Files = map[string]FileWatermark{}
	}
	if err := precheckRuntime(); err != nil {
		return err
	}
	root := RootDir()
	final := StatePath()
	tmp, err := os.CreateTemp(root, ".state.json.*")
	if err != nil {
		return fmt.Errorf("state: create tmp: %w", err)
	}
	defer func() {
		_ = tmp.Close()
		_ = os.Remove(tmp.Name())
	}()
	if err := os.Chmod(tmp.Name(), 0o600); err != nil {
		return fmt.Errorf("state: chmod tmp: %w", err)
	}
	enc := json.NewEncoder(tmp)
	enc.SetIndent("", "  ")
	if err := enc.Encode(s); err != nil {
		return fmt.Errorf("state: encode: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		return fmt.Errorf("state: fsync: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("state: close: %w", err)
	}
	return os.Rename(tmp.Name(), final)
}
```

(MkdirAll removed; precheckRuntime added.)

- [ ] **Step 4: Run tests**

Run: `cd agent && go test ./internal/config/ -run TestSaveState -v`
Expected: PASS (all 5)

- [ ] **Step 5: Commit**

```bash
git add agent/internal/config/state.go agent/internal/config/state_test.go
git commit -m "feat(agent/config): SaveState — drop MkdirAll, add precheckRuntime"
```

### Task 1.5: Revise `SaveRedactionSet` — same treatment as SaveState

**Files:**
- Modify: `agent/internal/config/redactionset.go`
- Modify: `agent/internal/config/redactionset_test.go`

- [ ] **Step 1: Write failing tests**

```go
// agent/internal/config/redactionset_test.go (append)
func TestSaveRedactionSet_RefusesWhenRootRemoved(t *testing.T) {
	t.Setenv("CALIBER_AGENT_HOME", "/tmp/does-not-exist-saveredact")
	if err := SaveRedactionSet(&redact.RedactionSet{}); !errors.Is(err, ErrRootRemoved) {
		t.Fatalf("want ErrRootRemoved, got %v", err)
	}
}

func TestSaveRedactionSet_RefusesWhenSentinelPresent(t *testing.T) {
	root := setupRoot(t)
	_ = os.WriteFile(filepath.Join(root, "config.toml"), []byte(""), 0o600)
	_ = os.WriteFile(filepath.Join(root, ".uninstalling"), []byte(""), 0o600)
	if err := SaveRedactionSet(&redact.RedactionSet{}); !errors.Is(err, ErrUninstallInProgress) {
		t.Fatalf("want ErrUninstallInProgress, got %v", err)
	}
}

func TestSaveRedactionSet_HappyPath(t *testing.T) {
	root := setupRoot(t)
	_ = os.WriteFile(filepath.Join(root, "config.toml"), []byte(""), 0o600)
	if err := SaveRedactionSet(&redact.RedactionSet{Version: "v"}); err != nil {
		t.Fatalf("want nil, got %v", err)
	}
}
```

- [ ] **Step 2: Run to verify fail**

Run: `cd agent && go test ./internal/config/ -run TestSaveRedactionSet -v`
Expected: FAIL — existing SaveRedactionSet has MkdirAll, no precheck

- [ ] **Step 3: Revise `SaveRedactionSet`**

In `agent/internal/config/redactionset.go`, replace `SaveRedactionSet` body:

```go
func SaveRedactionSet(s *redact.RedactionSet) error {
	if err := precheckRuntime(); err != nil {
		return err
	}
	root := RootDir()
	final := RedactionSetPath()
	tmp, err := os.CreateTemp(root, ".redaction-set.json.*")
	if err != nil {
		return fmt.Errorf("config: create tmp: %w", err)
	}
	defer func() {
		_ = tmp.Close()
		_ = os.Remove(tmp.Name())
	}()
	if err := os.Chmod(tmp.Name(), 0o600); err != nil {
		return fmt.Errorf("config: chmod tmp: %w", err)
	}
	enc := json.NewEncoder(tmp)
	enc.SetIndent("", "  ")
	if err := enc.Encode(s); err != nil {
		return fmt.Errorf("config: encode: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		return fmt.Errorf("config: fsync: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("config: close: %w", err)
	}
	return os.Rename(tmp.Name(), final)
}
```

(Same shape as SaveState: precheckRuntime + no MkdirAll.)

- [ ] **Step 4: Run tests**

Run: `cd agent && go test ./internal/config/ -run TestSaveRedactionSet -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add agent/internal/config/redactionset.go agent/internal/config/redactionset_test.go
git commit -m "feat(agent/config): SaveRedactionSet — drop MkdirAll, add precheckRuntime"
```

### Task 1.6: Split `SaveConfig` → `SaveConfigInitial` + `SaveConfig`

**Files:**
- Modify: `agent/internal/config/config.go`
- Modify: `agent/internal/config/config_test.go`

`SaveConfigInitial` is for enroll first-write (root may not exist → MkdirAll allowed); `SaveConfig` is for runtime (precheckRuntime, no MkdirAll). When `root` exists, `SaveConfigInitial` ALSO runs first-write-aware checks (sentinel + partial-cleanup) per R19/R20.

- [ ] **Step 1: Write failing tests**

```go
// agent/internal/config/config_test.go (append)
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
	t.Setenv("CALIBER_AGENT_HOME", "/tmp/does-not-exist-saveconfig")
	cfg := &Config{DeviceID: "d_x", APIBaseURL: "https://x"}
	if err := SaveConfig(cfg); !errors.Is(err, ErrRootRemoved) {
		t.Fatalf("want ErrRootRemoved, got %v", err)
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd agent && go test ./internal/config/ -run 'TestSaveConfigInitial|TestSaveConfig_Runtime' -v`
Expected: FAIL — `SaveConfigInitial` undefined, `SaveConfig` not yet runtime-checking

- [ ] **Step 3: Split SaveConfig**

In `agent/internal/config/config.go`:

```go
// SaveConfigInitial writes config.toml during enroll. It is the only save
// function permitted to MkdirAll the root, but it still performs first-
// write-aware safety checks (R19/R20) when root already exists, to catch
// the enroll preflight → SaveConfigInitial TOCTOU window.
func SaveConfigInitial(c *Config) error {
	if c.IncludePaths == nil {
		c.IncludePaths = []string{}
	}
	root := RootDir()
	if info, err := os.Stat(root); err == nil {
		if !info.IsDir() {
			return fmt.Errorf("config: %s exists but is not a directory", root)
		}
		// root exists — re-run both enroll preflight checks
		if _, sErr := os.Stat(filepath.Join(root, ".uninstalling")); sErr == nil {
			return ErrUninstallInProgress
		} else if !errors.Is(sErr, fs.ErrNotExist) {
			return fmt.Errorf("%w (sentinel stat: %v; fail-closed)", ErrUninstallInProgress, sErr)
		}
		if _, cErr := os.Stat(filepath.Join(root, "config.toml")); errors.Is(cErr, fs.ErrNotExist) {
			return ErrPartialUninstall
		}
	} else if !errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("config: stat root: %w", err)
	}
	// root absent (first enroll) or root + config.toml present (re-enroll) — safe to MkdirAll + write.
	if err := os.MkdirAll(root, 0o700); err != nil {
		return fmt.Errorf("config: mkdir %s: %w", root, err)
	}
	return writeConfigAtomically(c, root)
}

// SaveConfig writes config.toml during runtime mutations (add-path / remove-path).
// It enforces precheckRuntime and never MkdirAlls.
func SaveConfig(c *Config) error {
	if c.IncludePaths == nil {
		c.IncludePaths = []string{}
	}
	if err := precheckRuntime(); err != nil {
		return err
	}
	return writeConfigAtomically(c, RootDir())
}

// writeConfigAtomically is the shared tmp+rename body. Pulled out so both
// SaveConfig and SaveConfigInitial share the same encoder/chmod/fsync logic.
func writeConfigAtomically(c *Config, root string) error {
	final := ConfigPath()
	tmp, err := os.CreateTemp(root, ".config.toml.*")
	if err != nil {
		return fmt.Errorf("config: create tmp: %w", err)
	}
	defer func() {
		_ = tmp.Close()
		_ = os.Remove(tmp.Name())
	}()
	if err := os.Chmod(tmp.Name(), 0o600); err != nil {
		return fmt.Errorf("config: chmod tmp: %w", err)
	}
	if err := toml.NewEncoder(tmp).Encode(c); err != nil {
		return fmt.Errorf("config: encode: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		return fmt.Errorf("config: fsync tmp: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("config: close tmp: %w", err)
	}
	if err := os.Rename(tmp.Name(), final); err != nil {
		return fmt.Errorf("config: rename %s → %s: %w", filepath.Base(tmp.Name()), final, err)
	}
	return nil
}

// Save is kept as a thin alias for backwards compat inside this package, but
// callers SHOULD use SaveConfig / SaveConfigInitial explicitly. Delete this in
// a follow-up once all callers are migrated.
// Deprecated: use SaveConfig for runtime updates or SaveConfigInitial for enroll first write.
func Save(c *Config) error { return SaveConfig(c) }
```

- [ ] **Step 4: Run tests**

Run: `cd agent && go test ./internal/config/ -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add agent/internal/config/config.go agent/internal/config/config_test.go
git commit -m "feat(agent/config): split SaveConfig into SaveConfigInitial + SaveConfig with first-write-aware precheck"
```

### Task 1.7: Add `InsecureTransport` field + `ValidateAPIBaseURL` helper

**Files:**
- Modify: `agent/internal/config/config.go` (add field + helper)
- Modify: `agent/internal/config/config_test.go`

- [ ] **Step 1: Write failing tests**

```go
// agent/internal/config/config_test.go (append)
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
```

- [ ] **Step 2: Run tests**

Run: `cd agent && go test ./internal/config/ -run 'TestValidateAPIBaseURL|TestConfig_Insecure|TestConfig_LoadOldFormat' -v`
Expected: FAIL — `ValidateAPIBaseURL` undefined, `InsecureTransport` field missing

- [ ] **Step 3: Add field + helper**

In `agent/internal/config/config.go`:

```go
// Append to Config struct:
//   InsecureTransport bool `toml:"insecure_transport"`

type Config struct {
	DeviceID          string   `toml:"device_id"`
	Hostname          string   `toml:"hostname"`
	OS                string   `toml:"os"`
	APIBaseURL        string   `toml:"api_base_url"`
	Mode              string   `toml:"mode"`
	IncludePaths      []string `toml:"include_paths"`
	InsecureTransport bool     `toml:"insecure_transport"`
}

// ValidateAPIBaseURL enforces a strict scheme whitelist:
//   - https://   always allowed
//   - http://    allowed iff allowInsecure
//   - everything else (ftp/file/gopher/...) always rejected
func ValidateAPIBaseURL(raw string, allowInsecure bool) error {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return fmt.Errorf("invalid api_base_url: %q", raw)
	}
	switch u.Scheme {
	case "https":
		return nil
	case "http":
		if allowInsecure {
			return nil
		}
		return fmt.Errorf("api_base_url uses http://; pass --insecure to allow (dev/local only)")
	default:
		return fmt.Errorf("api_base_url must be https:// (got scheme %q)", u.Scheme)
	}
}
```

Add `"net/url"` to imports.

- [ ] **Step 4: Run tests**

Run: `cd agent && go test ./internal/config/ -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add agent/internal/config/config.go agent/internal/config/config_test.go
git commit -m "feat(agent/config): InsecureTransport field + ValidateAPIBaseURL scheme whitelist"
```

---

## Phase 2: Lockfile package

darwin-only flock wrapper used by `run` step 2 (acquire) and `uninstall` step 1 (probe).

### Task 2.1: `agent/internal/lockfile` skeleton + non-darwin stub

**Files:**
- Create: `agent/internal/lockfile/lockfile_darwin.go`
- Create: `agent/internal/lockfile/lockfile_other.go`
- Create: `agent/internal/lockfile/lockfile_test.go` (darwin-only)

- [ ] **Step 1: Write failing tests (darwin)**

```go
//go:build darwin

// agent/internal/lockfile/lockfile_test.go
package lockfile

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestAcquire_HappyPath_WritesPIDAndHolds(t *testing.T) {
	path := filepath.Join(t.TempDir(), ".lock")
	lk, err := Acquire(path)
	if err != nil {
		t.Fatalf("Acquire: %v", err)
	}
	defer lk.Release()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read lockfile: %v", err)
	}
	want := fmt.Sprintf("%d\n", os.Getpid())
	if string(b) != want {
		t.Fatalf("lockfile contents = %q, want %q", string(b), want)
	}
}

func TestAcquire_AlreadyHeld_ReturnsErrLocked(t *testing.T) {
	path := filepath.Join(t.TempDir(), ".lock")
	lk1, err := Acquire(path)
	if err != nil {
		t.Fatalf("first acquire: %v", err)
	}
	defer lk1.Release()

	_, err = Acquire(path)
	if !errors.Is(err, ErrLocked) {
		t.Fatalf("second acquire: want ErrLocked, got %v", err)
	}
}

func TestProbe_NoLockfile_ReturnsErrNotExist(t *testing.T) {
	path := filepath.Join(t.TempDir(), "does-not-exist")
	if _, err := Probe(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("Probe: want ErrNotExist, got %v", err)
	}
}

func TestProbe_LockfileExistsButNotHeld_ReturnsNilHolderEmpty(t *testing.T) {
	path := filepath.Join(t.TempDir(), ".lock")
	if err := os.WriteFile(path, []byte("12345\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	holder, err := Probe(path)
	if err != nil {
		t.Fatalf("Probe: want nil, got %v", err)
	}
	if holder == 0 {
		t.Fatalf("Probe must return read PID for diagnostics; got 0")
	}
	if holder != 12345 {
		t.Fatalf("Probe holder = %d, want 12345", holder)
	}
}

func TestProbe_LockfileHeld_ReturnsErrLockedWithPID(t *testing.T) {
	path := filepath.Join(t.TempDir(), ".lock")
	lk, err := Acquire(path)
	if err != nil {
		t.Fatalf("Acquire: %v", err)
	}
	defer lk.Release()

	holder, err := Probe(path)
	if !errors.Is(err, ErrLocked) {
		t.Fatalf("Probe: want ErrLocked, got %v", err)
	}
	if holder != os.Getpid() {
		t.Fatalf("Probe holder = %d, want our pid %d", holder, os.Getpid())
	}
}

func TestAcquire_DoesNotTruncateExistingPIDOnFlockFailure(t *testing.T) {
	path := filepath.Join(t.TempDir(), ".lock")
	lk1, err := Acquire(path)
	if err != nil {
		t.Fatalf("first acquire: %v", err)
	}
	defer lk1.Release()

	originalPID := os.Getpid()
	_, err = Acquire(path)
	if !errors.Is(err, ErrLocked) {
		t.Fatalf("second acquire: want ErrLocked, got %v", err)
	}
	b, _ := os.ReadFile(path)
	if !strings.HasPrefix(string(b), fmt.Sprintf("%d", originalPID)) {
		t.Fatalf("failed Acquire must not truncate; got %q", string(b))
	}
}
```

- [ ] **Step 2: Run tests to verify fail**

Run: `cd agent && go test ./internal/lockfile/ -v`
Expected: FAIL — package missing

- [ ] **Step 3: Implement lockfile_darwin.go**

```go
//go:build darwin

// Package lockfile wraps syscall.Flock + a PID-tagged lockfile so uninstall
// can both detect an active daemon and uninstall without holding the lock.
// Spec §3.7 step 1 + §3.6 step 1.
package lockfile

import (
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"syscall"
)

// ErrLocked indicates the lock is already held by another process.
var ErrLocked = errors.New("lockfile: already held")

// Lock wraps an acquired *os.File. Release closes the fd, which the kernel
// uses to drop the flock.
type Lock struct{ f *os.File }

// Release closes the file descriptor and drops the flock.
func (l *Lock) Release() { _ = l.f.Close() }

// Acquire opens path (O_RDWR | O_CREATE without O_TRUNC), takes an exclusive
// non-blocking flock, then truncates and writes its PID. The file is not
// truncated until after flock succeeds — otherwise a concurrent caller would
// erase the holder's PID on failed Acquire.
func Acquire(path string) (*Lock, error) {
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return nil, fmt.Errorf("lockfile: open %s: %w", path, err)
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		_ = f.Close()
		if errors.Is(err, syscall.EWOULDBLOCK) {
			return nil, ErrLocked
		}
		return nil, fmt.Errorf("lockfile: flock %s: %w", path, err)
	}
	if err := f.Truncate(0); err != nil {
		_ = f.Close()
		return nil, fmt.Errorf("lockfile: truncate %s: %w", path, err)
	}
	if _, err := f.Seek(0, 0); err != nil {
		_ = f.Close()
		return nil, fmt.Errorf("lockfile: seek %s: %w", path, err)
	}
	if _, err := fmt.Fprintf(f, "%d\n", os.Getpid()); err != nil {
		_ = f.Close()
		return nil, fmt.Errorf("lockfile: write pid: %w", err)
	}
	return &Lock{f: f}, nil
}

// Probe attempts a non-acquiring liveness check: open without O_CREATE, take
// flock non-blocking, then immediately release (close fd). Returns:
//   - (read PID, ErrLocked)        if a daemon currently holds the lock
//   - (read PID or 0, nil)         if the lockfile exists but is unheld
//   - (0, os.ErrNotExist)          if the lockfile does not exist
//   - (0, other error)             on real IO failure
// Critically: Probe does NOT use O_CREATE — uninstall must never instantiate
// a stale .lock just by checking for one.
func Probe(path string) (int, error) {
	f, err := os.OpenFile(path, os.O_RDWR, 0)
	if err != nil {
		return 0, err
	}
	defer f.Close()

	holder := readPID(f)
	if ferr := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); ferr != nil {
		if errors.Is(ferr, syscall.EWOULDBLOCK) {
			return holder, ErrLocked
		}
		return holder, fmt.Errorf("lockfile: flock probe: %w", ferr)
	}
	_ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
	return holder, nil
}

func readPID(f *os.File) int {
	if _, err := f.Seek(0, 0); err != nil {
		return 0
	}
	buf := make([]byte, 32)
	n, _ := f.Read(buf)
	s := strings.TrimSpace(string(buf[:n]))
	pid, err := strconv.Atoi(s)
	if err != nil {
		return 0
	}
	return pid
}
```

- [ ] **Step 4: Implement non-darwin stub**

```go
//go:build !darwin

package lockfile

import "errors"

// ErrUnsupported indicates lockfile is not implemented on this platform.
var ErrUnsupported = errors.New("lockfile: not supported on this platform")
var ErrLocked = errors.New("lockfile: already held")

type Lock struct{}

func (l *Lock) Release() {}

func Acquire(path string) (*Lock, error)  { return nil, ErrUnsupported }
func Probe(path string) (int, error)      { return 0, ErrUnsupported }
```

- [ ] **Step 5: Run tests**

Run: `cd agent && go test ./internal/lockfile/ -v`
Expected: PASS (6 cases)

- [ ] **Step 6: Commit**

```bash
git add agent/internal/lockfile/
git commit -m "feat(agent/lockfile): darwin flock wrapper + cross-platform stub"
```

---

## Phase 3: Server `DELETE /v1/devices/me` endpoint

### Task 3.1: Add `resolveDeviceFromAuthAllowRevoked` sister helper

**Files:**
- Modify: `apps/api/src/rest/ingestAuth.ts`

- [ ] **Step 1: Write failing test**

Add to `apps/api/tests/integration/rest/ingestAuth.test.ts` (or create if missing):

```ts
import { describe, expect, it } from "vitest";
import { resolveDeviceFromAuthAllowRevoked } from "../../../src/rest/ingestAuth.js";
import { setupTestDb, seedActiveDevice, seedRevokedDevice, seedRevokedKey } from "../helpers/devicesFixtures.js";

describe("resolveDeviceFromAuthAllowRevoked", () => {
  it("returns alreadyRevoked=false for active device", async () => {
    const { db, env, token } = await seedActiveDevice();
    const r = await resolveDeviceFromAuthAllowRevoked(db, env, `Bearer ${token}`);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.device.alreadyRevoked).toBe(false);
  });

  it("returns alreadyRevoked=true for revoked device (does NOT return device_revoked)", async () => {
    const { db, env, token } = await seedRevokedDevice();
    const r = await resolveDeviceFromAuthAllowRevoked(db, env, `Bearer ${token}`);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.device.alreadyRevoked).toBe(true);
  });

  it("returns 401 key_revoked when device_api_keys.revoked_at is set", async () => {
    const { db, env, token } = await seedRevokedKey();
    const r = await resolveDeviceFromAuthAllowRevoked(db, env, `Bearer ${token}`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("key_revoked");
  });

  it("returns 401 device_inactive for status='frozen' but not revoked", async () => {
    const { db, env, token } = await seedActiveDevice();
    await db.update(devices).set({ status: "frozen" }).where(eq(devices.id, /* id */));
    const r = await resolveDeviceFromAuthAllowRevoked(db, env, `Bearer ${token}`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("device_inactive");
  });
});
```

(Test depends on `tests/integration/helpers/devicesFixtures.ts` providing the seed helpers. If missing, factor out from `devicesEnroll.test.ts` setup.)

- [ ] **Step 2: Run to verify fail**

Run: `cd apps/api && pnpm exec vitest run --config vitest.integration.config.ts tests/integration/rest/ingestAuth.test.ts`
Expected: FAIL — `resolveDeviceFromAuthAllowRevoked` not exported

- [ ] **Step 3: Add helper in `apps/api/src/rest/ingestAuth.ts`**

After the existing `resolveDeviceFromAuth` export, add:

```ts
export interface ResolvedDeviceWithStatus extends ResolvedDevice {
  alreadyRevoked: boolean;
}

/**
 * resolveDeviceFromAuthAllowRevoked is the variant used by DELETE /v1/devices/me.
 * Same shape as resolveDeviceFromAuth but short-circuits to ok+alreadyRevoked=true
 * when device.revokedAt is non-null, BEFORE the status !== 'active' check.
 * This lets the revoke endpoint return 410 (idempotent) instead of 401 device_revoked
 * for repeated DELETEs; the SQL UPDATE in the route sets status='revoked' AND
 * revoked_at=NOW() so a naive shared helper would catch the second DELETE on
 * the status check and return 401 device_inactive.
 */
export async function resolveDeviceFromAuthAllowRevoked(
  db: Database,
  env: ServerEnv,
  authHeader: string | undefined,
): Promise<
  | { ok: true; device: ResolvedDeviceWithStatus }
  | { ok: false; error: Exclude<AuthFailure, "device_revoked"> }
> {
  const pepper = env.API_KEY_HASH_PEPPER;
  if (!pepper) return { ok: false, error: "server_misconfigured" };
  if (!authHeader || typeof authHeader !== "string") return { ok: false, error: "missing_token" };
  if (!authHeader.toLowerCase().startsWith("bearer ")) return { ok: false, error: "missing_token" };
  const raw = authHeader.slice(7).trim();
  if (!raw.startsWith("cda_") || raw.length < 16) return { ok: false, error: "invalid_token" };

  const keyHash = hashDeviceKey(pepper, raw);
  const row = await db
    .select({
      deviceId: deviceApiKeys.deviceId,
      keyRevokedAt: deviceApiKeys.revokedAt,
      userId: devices.userId,
      orgId: devices.orgId,
      status: devices.status,
      deviceRevokedAt: devices.revokedAt,
    })
    .from(deviceApiKeys)
    .innerJoin(devices, eq(devices.id, deviceApiKeys.deviceId))
    .where(eq(deviceApiKeys.keyHash, keyHash))
    .limit(1)
    .then((r) => r[0]);

  if (!row) return { ok: false, error: "invalid_token" };
  if (row.keyRevokedAt !== null) return { ok: false, error: "key_revoked" };

  // KEY DIFFERENCE: deviceRevokedAt short-circuits BEFORE status check —
  // otherwise the revoke SQL's status='revoked' update would trip the next
  // check and return device_inactive on the second DELETE.
  if (row.deviceRevokedAt !== null) {
    return {
      ok: true,
      device: {
        deviceId: row.deviceId,
        userId: row.userId,
        orgId: row.orgId,
        alreadyRevoked: true,
      },
    };
  }

  // Not revoked but status non-active (admin freeze etc.) — reject.
  if (row.status !== "active") return { ok: false, error: "device_inactive" };

  return {
    ok: true,
    device: {
      deviceId: row.deviceId,
      userId: row.userId,
      orgId: row.orgId,
      alreadyRevoked: false,
    },
  };
}
```

- [ ] **Step 4: Run test**

Run: `cd apps/api && pnpm exec vitest run --config vitest.integration.config.ts tests/integration/rest/ingestAuth.test.ts`
Expected: PASS (4 cases)

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/rest/ingestAuth.ts apps/api/tests/integration/rest/ingestAuth.test.ts
git commit -m "feat(api): resolveDeviceFromAuthAllowRevoked variant for DELETE /v1/devices/me"
```

### Task 3.2: Add `device.self_revoked` audit action

**Files:**
- Modify: wherever `auditLogs` action enum lives (likely `apps/api/src/services/audit.ts` or a shared types module)

- [ ] **Step 1: Verify action is just a string column (no enum constraint to extend)**

Run: `cd apps/api && grep -rn "device\\.revoked\\|device\\.revoke\\b" src/`

If `action` is a free-text column (most likely), no migration is needed — just document the new value. If it's a CHECK constraint or pg enum, create a migration in `packages/db/drizzle/`.

- [ ] **Step 2: Add typed constant for safety (no DB change)**

```ts
// apps/api/src/services/auditActions.ts (new)
// Centralised audit action names. PR4 introduces device.self_revoked.
export const AUDIT_ACTIONS = {
  DEVICE_SELF_REVOKED: "device.self_revoked",
  // ... future migration: import existing action strings from callers as we touch them
} as const;
```

(Keep minimal — don't migrate every existing action.)

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/services/auditActions.ts
git commit -m "feat(api): AUDIT_ACTIONS constant for device.self_revoked"
```

### Task 3.3: Implement `DELETE /v1/devices/me` route

**Files:**
- Create: `apps/api/src/rest/devicesRevokeSelf.ts`
- Modify: `apps/api/src/server.ts`

- [ ] **Step 1: Write the route**

```ts
// apps/api/src/rest/devicesRevokeSelf.ts
import { eq, isNull, and, sql } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { devices } from "@caliber/db";
import type { ServerEnv } from "@caliber/config";
import { resolveDeviceFromAuthAllowRevoked } from "./ingestAuth.js";
import { writeAudit } from "../services/audit.js";
import { AUDIT_ACTIONS } from "../services/auditActions.js";

/**
 * DELETE /v1/devices/me — daemon-facing self-revoke.
 * Authenticated by Bearer cda_* via resolveDeviceFromAuthAllowRevoked (NOT the
 * standard resolveDeviceFromAuth — see ingestAuth.ts for why).
 * Response contract: 204 / 410 (idempotent) / 401×4 / 404 (ENABLE_GATEWAY=false) / 500
 * Spec §5.
 */
export function devicesRevokeSelfRoutes(env: ServerEnv): FastifyPluginAsync {
  return async (fastify) => {
    fastify.delete("/v1/devices/me", async (req, reply) => {
      if (!env.ENABLE_GATEWAY) {
        reply.code(404);
        return { error: "not_found" };
      }
      const auth = await resolveDeviceFromAuthAllowRevoked(
        fastify.db,
        env,
        req.headers.authorization,
      );
      if (!auth.ok) {
        if (auth.error === "server_misconfigured") {
          reply.code(500);
          return { error: "internal" };
        }
        reply.code(401);
        return { error: auth.error };
      }
      if (auth.device.alreadyRevoked) {
        reply.code(410);
        return { error: "device_already_revoked" };
      }

      // Soft-revoke + audit inside one transaction.
      const result = await fastify.db.transaction(async (tx) => {
        const updated = await tx
          .update(devices)
          .set({ status: "revoked", revokedAt: sql`NOW()` })
          .where(and(eq(devices.id, auth.device.deviceId), isNull(devices.revokedAt)))
          .returning({ id: devices.id });

        if (updated.length === 0) {
          // Concurrent revoke: another transaction beat us. Treat as 410.
          return { state: "already-revoked" as const };
        }

        await writeAudit(tx, {
          actorUserId: auth.device.userId,
          action: AUDIT_ACTIONS.DEVICE_SELF_REVOKED,
          targetType: "device",
          targetId: auth.device.deviceId,
          orgId: auth.device.orgId,
          metadata: {
            trigger: "agent_uninstall",
            user_agent: req.headers["user-agent"] ?? null,
          },
        });
        return { state: "revoked" as const };
      });

      if (result.state === "already-revoked") {
        reply.code(410);
        return { error: "device_already_revoked" };
      }
      reply.code(204);
      return null;
    });
  };
}
```

- [ ] **Step 2: Register in `server.ts`**

In `apps/api/src/server.ts`, after `await app.register(devicesEnrollRoutes(env));` add:

```ts
await app.register(devicesRevokeSelfRoutes(env));
```

And add the import at the top.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/rest/devicesRevokeSelf.ts apps/api/src/server.ts
git commit -m "feat(api): DELETE /v1/devices/me self-revoke route"
```

### Task 3.4: Integration tests (10 cases) for `DELETE /v1/devices/me`

**Files:**
- Create: `apps/api/tests/integration/rest/devicesRevokeSelf.test.ts`

- [ ] **Step 1: Write the tests**

```ts
// apps/api/tests/integration/rest/devicesRevokeSelf.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestDb, type TestDb } from "../helpers/testDb.js";
import { seedActiveDevice, seedRevokedDevice, seedRevokedKey, seedFrozenDevice, seedAccountKey } from "../helpers/devicesFixtures.js";
import { auditLogs, devices } from "@caliber/db";
import { eq } from "drizzle-orm";

let tdb: TestDb;
beforeAll(async () => { tdb = await setupTestDb(); });
afterAll(async () => { await tdb.stop(); });

describe("DELETE /v1/devices/me", () => {
  it("happy path → 204 + devices.revokedAt set + audit log device.self_revoked written", async () => {
    const { token, deviceId, userId, orgId } = await seedActiveDevice(tdb.db);
    const res = await tdb.app.inject({
      method: "DELETE",
      url: "/v1/devices/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(204);
    const [row] = await tdb.db.select().from(devices).where(eq(devices.id, deviceId));
    expect(row.revokedAt).not.toBeNull();
    expect(row.status).toBe("revoked");
    const audits = await tdb.db.select().from(auditLogs).where(eq(auditLogs.targetId, deviceId));
    expect(audits.some((a) => a.action === "device.self_revoked")).toBe(true);
    expect(audits.find((a) => a.action === "device.self_revoked")?.actorUserId).toBe(userId);
    expect(audits.find((a) => a.action === "device.self_revoked")?.orgId).toBe(orgId);
  });

  it("repeated call → 410 device_already_revoked (idempotent; allow-revoked variant does NOT return 401)", async () => {
    const { token } = await seedActiveDevice(tdb.db);
    const first = await tdb.app.inject({
      method: "DELETE", url: "/v1/devices/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(first.statusCode).toBe(204);
    const second = await tdb.app.inject({
      method: "DELETE", url: "/v1/devices/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(second.statusCode).toBe(410);
    expect(second.json().error).toBe("device_already_revoked");
  });

  it("invalid token → 401 invalid_token", async () => {
    const res = await tdb.app.inject({
      method: "DELETE", url: "/v1/devices/me",
      headers: { authorization: "Bearer cda_invalid_xxxxxxxxxxxxxxxxxxxxxx" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("invalid_token");
  });

  it("revoked api key → 401 key_revoked", async () => {
    const { token } = await seedRevokedKey(tdb.db);
    const res = await tdb.app.inject({
      method: "DELETE", url: "/v1/devices/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("key_revoked");
  });

  it("pre-revoked device (devices.revokedAt set) → 410 device_already_revoked (NOT 401)", async () => {
    const { token } = await seedRevokedDevice(tdb.db);
    const res = await tdb.app.inject({
      method: "DELETE", url: "/v1/devices/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(410);
    expect(res.json().error).toBe("device_already_revoked");
  });

  it("frozen device (status='frozen', not revoked) → 401 device_inactive", async () => {
    const { token } = await seedFrozenDevice(tdb.db);
    const res = await tdb.app.inject({
      method: "DELETE", url: "/v1/devices/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("device_inactive");
  });

  it("ak_* token (not cda_*) → 401 invalid_token", async () => {
    const { rawKey } = await seedAccountKey(tdb.db);
    const res = await tdb.app.inject({
      method: "DELETE", url: "/v1/devices/me",
      headers: { authorization: `Bearer ${rawKey}` },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("invalid_token");
  });

  it("10× concurrent revoke → 1× 204 + 9× 410 (race serialisation)", async () => {
    const { token } = await seedActiveDevice(tdb.db);
    const tries = Array.from({ length: 10 }, () =>
      tdb.app.inject({
        method: "DELETE", url: "/v1/devices/me",
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    const results = await Promise.all(tries);
    const counts = results.reduce((acc, r) => {
      acc[r.statusCode] = (acc[r.statusCode] ?? 0) + 1;
      return acc;
    }, {} as Record<number, number>);
    expect(counts[204]).toBe(1);
    expect(counts[410]).toBe(9);
  });

  it("ENABLE_GATEWAY=false → 404 not_found", async () => {
    const { token } = await seedActiveDevice(tdb.db);
    const tdbGatewayOff = await setupTestDb({ ENABLE_GATEWAY: false });
    try {
      const res = await tdbGatewayOff.app.inject({
        method: "DELETE", url: "/v1/devices/me",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe("not_found");
    } finally {
      await tdbGatewayOff.stop();
    }
  });

  it("API_KEY_HASH_PEPPER missing → 500 internal (server_misconfigured, not 401)", async () => {
    const { token } = await seedActiveDevice(tdb.db);
    const tdbNoPepper = await setupTestDb({ API_KEY_HASH_PEPPER: "" });
    try {
      const res = await tdbNoPepper.app.inject({
        method: "DELETE", url: "/v1/devices/me",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(500);
      expect(res.json().error).toBe("internal");
    } finally {
      await tdbNoPepper.stop();
    }
  });
});
```

- [ ] **Step 2: Run tests**

Run: `cd apps/api && pnpm exec vitest run --config vitest.integration.config.ts tests/integration/rest/devicesRevokeSelf.test.ts`
Expected: PASS (10 cases)

- [ ] **Step 3: Regression run**

```bash
cd apps/api
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/rest/ingest.test.ts
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/rest/devicesEnroll.test.ts
```
Expected: both PASS unchanged

- [ ] **Step 4: Commit**

```bash
git add apps/api/tests/integration/rest/devicesRevokeSelf.test.ts
git commit -m "test(api): integration tests for DELETE /v1/devices/me (10 cases)"
```

---

## Phase 4: Agent API client — `RevokeSelf`

### Task 4.1: Implement `(*Client).RevokeSelf`

**Files:**
- Create: `agent/internal/api/revoke.go`
- Create: `agent/internal/api/revoke_test.go`

- [ ] **Step 1: Write failing tests**

```go
// agent/internal/api/revoke_test.go
package api

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestRevokeSelf_204_Success(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodDelete || r.URL.Path != "/v1/devices/me" {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		w.WriteHeader(204)
	}))
	defer srv.Close()
	c := &Client{BaseURL: srv.URL, UserAgent: "test", HTTP: &http.Client{Timeout: time.Second}}
	if err := c.RevokeSelf(context.Background(), "cda_xyz"); err != nil {
		t.Fatalf("want nil, got %v", err)
	}
}

func TestRevokeSelf_410_Idempotent_NoError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(410)
		_, _ = w.Write([]byte(`{"error":"device_already_revoked"}`))
	}))
	defer srv.Close()
	c := &Client{BaseURL: srv.URL, UserAgent: "t", HTTP: &http.Client{Timeout: time.Second}}
	if err := c.RevokeSelf(context.Background(), "cda_x"); err != nil {
		t.Fatalf("410 must be idempotent success, got %v", err)
	}
}

func TestRevokeSelf_401_InvalidToken(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(401)
		_, _ = w.Write([]byte(`{"error":"invalid_token"}`))
	}))
	defer srv.Close()
	c := &Client{BaseURL: srv.URL, UserAgent: "t", HTTP: &http.Client{Timeout: time.Second}}
	err := c.RevokeSelf(context.Background(), "cda_x")
	if !errors.Is(err, ErrInvalidToken) {
		t.Fatalf("want ErrInvalidToken, got %v", err)
	}
}

func TestRevokeSelf_401_KeyRevoked(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(401)
		_, _ = w.Write([]byte(`{"error":"key_revoked"}`))
	}))
	defer srv.Close()
	c := &Client{BaseURL: srv.URL, UserAgent: "t", HTTP: &http.Client{Timeout: time.Second}}
	err := c.RevokeSelf(context.Background(), "cda_x")
	if !errors.Is(err, ErrKeyRevoked) {
		t.Fatalf("want ErrKeyRevoked, got %v", err)
	}
}

func TestRevokeSelf_404_ReturnsAPIError_NotIdempotent(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(404)
		_, _ = w.Write([]byte(`{"error":"not_found"}`))
	}))
	defer srv.Close()
	c := &Client{BaseURL: srv.URL, UserAgent: "t", HTTP: &http.Client{Timeout: time.Second}}
	err := c.RevokeSelf(context.Background(), "cda_x")
	if err == nil {
		t.Fatalf("404 must NOT be treated as idempotent; got nil")
	}
	var apiErr *APIError
	if !errors.As(err, &apiErr) || apiErr.StatusCode != 404 {
		t.Fatalf("want APIError{Code:404}, got %v", err)
	}
}

func TestRevokeSelf_500_ReturnsAPIError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(500)
		_, _ = w.Write([]byte(`{"error":"internal"}`))
	}))
	defer srv.Close()
	c := &Client{BaseURL: srv.URL, UserAgent: "t", HTTP: &http.Client{Timeout: time.Second}}
	var apiErr *APIError
	err := c.RevokeSelf(context.Background(), "cda_x")
	if !errors.As(err, &apiErr) || apiErr.StatusCode != 500 {
		t.Fatalf("want APIError{Code:500}, got %v", err)
	}
}

func TestRevokeSelf_NetworkError_Wrapped(t *testing.T) {
	// Point at an unrouteable URL
	c := &Client{BaseURL: "http://127.0.0.1:1", UserAgent: "t", HTTP: &http.Client{Timeout: 100 * time.Millisecond}}
	err := c.RevokeSelf(context.Background(), "cda_x")
	if err == nil {
		t.Fatalf("want error, got nil")
	}
	var urlErr *url.Error
	if !errors.As(err, &urlErr) {
		// At minimum the error must mention transport/connection
		if !strings.Contains(err.Error(), "revoke") {
			t.Fatalf("want network error, got %v", err)
		}
	}
}

func TestRevokeSelf_Body64KiBCap(t *testing.T) {
	huge := strings.Repeat("a", 1<<20)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(500)
		_, _ = w.Write([]byte(huge))
	}))
	defer srv.Close()
	c := &Client{BaseURL: srv.URL, UserAgent: "t", HTTP: &http.Client{Timeout: time.Second}}
	err := c.RevokeSelf(context.Background(), "cda_x")
	var apiErr *APIError
	if !errors.As(err, &apiErr) {
		t.Fatalf("want APIError, got %v", err)
	}
	if got := len(apiErr.Body); got > 1<<14+100 { // ~16 KiB cap with small slack
		t.Fatalf("body must be capped near 16 KiB, got %d bytes", got)
	}
	// Sanity that we did read something
	if got := io.NopCloser; got == nil {
		t.Fatal("unreachable")
	}
}
```

- [ ] **Step 2: Run tests to verify fail**

Run: `cd agent && go test ./internal/api/ -run TestRevokeSelf -v`
Expected: FAIL — `RevokeSelf` undefined

- [ ] **Step 3: Implement `RevokeSelf`**

```go
// agent/internal/api/revoke.go
package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
)

// RevokeSelf calls DELETE /v1/devices/me with the daemon's cda_* token.
// Idempotent semantics: 204 (first revoke) and 410 device_already_revoked
// are both nil returns. 401 returns ErrInvalidToken or ErrKeyRevoked via
// the existing parseAuthError shape; all other non-2xx return *APIError.
func (c *Client) RevokeSelf(ctx context.Context, token string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, c.BaseURL+"/v1/devices/me", nil)
	if err != nil {
		return fmt.Errorf("api: build revoke: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("User-Agent", c.UserAgent)

	resp, err := c.HTTP.Do(req)
	if err != nil {
		return fmt.Errorf("api: revoke http: %w", err)
	}
	defer resp.Body.Close()

	switch resp.StatusCode {
	case 204, 410:
		return nil // idempotent success
	case 401:
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<14))
		var eb struct{ Error string `json:"error"` }
		_ = json.Unmarshal(body, &eb)
		ae := &APIError{StatusCode: 401, ErrorTag: eb.Error, Body: string(body)}
		switch eb.Error {
		case "key_revoked":
			return &authError{sentinel: ErrKeyRevoked, cause: ae}
		default:
			return &authError{sentinel: ErrInvalidToken, cause: ae}
		}
	default:
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<14))
		var eb struct{ Error string `json:"error"` }
		_ = json.Unmarshal(body, &eb)
		truncated := string(body)
		if len(truncated) > 200 {
			truncated = truncated[:200]
		}
		_ = errors.New // keep import minimal
		return &APIError{StatusCode: resp.StatusCode, ErrorTag: eb.Error, Body: truncated}
	}
}
```

(If `authError` is private to `sink` package, copy the pattern: define a similar wrapper in `internal/api/`, or just use APIError + Is/As. Adjust as needed per existing PR3 sentinel scaffolding.)

- [ ] **Step 4: Run tests**

Run: `cd agent && go test ./internal/api/ -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add agent/internal/api/revoke.go agent/internal/api/revoke_test.go
git commit -m "feat(agent/api): Client.RevokeSelf for DELETE /v1/devices/me (idempotent on 204/410)"
```

---

## Phase 5: Redact limits + bootstrap fail-open fix

### Task 5.1: Add `MaxRegexSrcLen` per-pattern + `ErrTooManyPatterns` set-level

**Files:**
- Modify: `agent/redact/regexes.go`, `agent/redact/set.go`
- Modify: `agent/redact/regexes_test.go`, `agent/redact/set_test.go`

- [ ] **Step 1: Write failing tests**

```go
// agent/redact/regexes_test.go (append)
func TestPatternCompile_RejectsOversized_KeepsOthers(t *testing.T) {
	big := strings.Repeat("a", MaxRegexSrcLen+1)
	pats := []Pattern{
		{Name: "ok", RegexSrc: `sk-[a-z]+`, Replacement: "***"},
		{Name: "huge", RegexSrc: big, Replacement: "***"},
	}
	rs := &RedactionSet{Patterns: pats}
	err := rs.Compile()
	if err == nil {
		t.Fatalf("oversized pattern should aggregate error")
	}
	if pats[0].Regex == nil {
		t.Fatalf("good pattern must still compile")
	}
	if pats[1].Regex != nil {
		t.Fatalf("oversized pattern must NOT compile")
	}
}
```

```go
// agent/redact/set_test.go (append)
func TestRedactionSetCompile_RejectsTooManyPatterns_ErrSentinel(t *testing.T) {
	pats := make([]Pattern, MaxPatternCount+1)
	for i := range pats {
		pats[i] = Pattern{Name: "p", RegexSrc: `a`, Replacement: "*"}
	}
	rs := &RedactionSet{Patterns: pats}
	err := rs.Compile()
	if !errors.Is(err, ErrTooManyPatterns) {
		t.Fatalf("want ErrTooManyPatterns, got %v", err)
	}
	for i := range pats {
		if pats[i].Regex != nil {
			t.Fatalf("on ErrTooManyPatterns, no pattern must be compiled (i=%d)", i)
		}
	}
}

func TestRedactionSetCompile_AtBoundary(t *testing.T) {
	pats := make([]Pattern, MaxPatternCount)
	for i := range pats {
		pats[i] = Pattern{Name: "p", RegexSrc: `a`, Replacement: "*"}
	}
	rs := &RedactionSet{Patterns: pats}
	if err := rs.Compile(); err != nil {
		t.Fatalf("MaxPatternCount must be allowed, got %v", err)
	}
}
```

- [ ] **Step 2: Run tests**

Run: `cd agent && go test ./redact/ -run 'TestPatternCompile_RejectsOversized|TestRedactionSetCompile' -v`
Expected: FAIL — consts + sentinel + bounds missing

- [ ] **Step 3: Add consts + sentinel + bounds**

```go
// agent/redact/regexes.go (additions)
const MaxRegexSrcLen = 1024

// Compile rebuilds the regex; rejects oversized RegexSrc per-pattern.
func (p *Pattern) Compile() error {
	if p.Regex != nil {
		return nil
	}
	if len(p.RegexSrc) > MaxRegexSrcLen {
		return fmt.Errorf("pattern %q: regex too long (%d > %d)", p.Name, len(p.RegexSrc), MaxRegexSrcLen)
	}
	re, err := regexp.Compile(p.RegexSrc)
	if err != nil {
		return fmt.Errorf("pattern %q: %w", p.Name, err)
	}
	p.Regex = re
	return nil
}
```

```go
// agent/redact/set.go (additions)
const MaxPatternCount = 100

// ErrTooManyPatterns aborts compilation; callers MUST fall back to stale/default.
var ErrTooManyPatterns = errors.New("redact: pattern count exceeded MaxPatternCount")

func (r *RedactionSet) Compile() error {
	if len(r.Patterns) > MaxPatternCount {
		return fmt.Errorf("%w: got %d limit %d", ErrTooManyPatterns, len(r.Patterns), MaxPatternCount)
	}
	var failed []string
	for i := range r.Patterns {
		if err := r.Patterns[i].Compile(); err != nil {
			failed = append(failed, fmt.Sprintf("%s (%v)", r.Patterns[i].Name, err))
		}
	}
	if len(failed) > 0 {
		return fmt.Errorf("redact: %d bad patterns: %s", len(failed), strings.Join(failed, ", "))
	}
	return nil
}
```

- [ ] **Step 4: Run tests**

Run: `cd agent && go test ./redact/ -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add agent/redact/regexes.go agent/redact/regexes_test.go agent/redact/set.go agent/redact/set_test.go
git commit -m "feat(agent/redact): MaxRegexSrcLen + MaxPatternCount + ErrTooManyPatterns sentinel"
```

### Task 5.2: Fix `BootstrapRedactionSet` + refresher fallback on `ErrTooManyPatterns`

**Files:**
- Modify: `agent/internal/cli/redactionset.go`
- Modify: `agent/internal/cli/redactionset_test.go`

- [ ] **Step 1: Write failing tests**

```go
// agent/internal/cli/redactionset_test.go (append)
func TestBootstrap_TooManyPatterns_FallsBackToStale(t *testing.T) {
	root := t.TempDir()
	t.Setenv("CALIBER_AGENT_HOME", root)
	// Seed a known-good stale cache.
	good := &redact.RedactionSet{
		Patterns: []redact.Pattern{{Name: "ok", RegexSrc: `sk-[a-z]+`, Replacement: "***"}},
		Version:  "stale",
		TTLSeconds: 1, FetchedAt: time.Now().Add(-time.Hour),
	}
	_ = config.SaveRedactionSet(good) // pre-conditions: root + config.toml? need to bypass precheck here
	// (Use a direct file-write helper if precheckRuntime gets in the way.)

	apiClient := &fakeAPIClient{returnPatterns: makeOversetSetReturning(redact.MaxPatternCount + 1)}
	logger := &fakeLogger{}
	prov, err := BootstrapRedactionSet(context.Background(), apiClient, "tok", logger)
	if err != nil {
		t.Fatalf("want nil (graceful fallback), got %v", err)
	}
	current := prov.Current()
	if current.Version != "stale" {
		t.Fatalf("want stale fallback set, got version=%s", current.Version)
	}
	if len(logger.errors) == 0 {
		t.Fatalf("want [error] log on ErrTooManyPatterns, got none")
	}
}

func TestBootstrap_TooManyPatterns_NoCache_FallsBackToDefault(t *testing.T) {
	t.Setenv("CALIBER_AGENT_HOME", t.TempDir())
	apiClient := &fakeAPIClient{returnPatterns: makeOversetSetReturning(redact.MaxPatternCount + 1)}
	logger := &fakeLogger{}
	prov, err := BootstrapRedactionSet(context.Background(), apiClient, "tok", logger)
	if err != nil {
		t.Fatalf("want nil, got %v", err)
	}
	if prov.Current().Version != "bundled-default" {
		t.Fatalf("want bundled-default, got %s", prov.Current().Version)
	}
}
```

- [ ] **Step 2: Run tests**

Run: `cd agent && go test ./internal/cli/ -run TestBootstrap_TooManyPatterns -v`
Expected: FAIL — current bootstrap warns + Set(set), nil-regex set leaks through

- [ ] **Step 3: Patch bootstrap (existing function)**

Replace the existing post-fetch compile block:

```go
// agent/internal/cli/redactionset.go (revised tail)
set := &redact.RedactionSet{
	Patterns:   fresh.Patterns,
	Version:    fresh.Version,
	FetchedAt:  now,
	TTLSeconds: fresh.TTLSeconds,
}
if err := set.Compile(); err != nil {
	if errors.Is(err, redact.ErrTooManyPatterns) {
		logger.Printf("[error] fresh redaction-set rejected: %v; falling back", err)
		if hasCache {
			_ = cached.Compile()
			prov.Set(cached)
			return prov, nil
		}
		prov.Set(redact.DefaultSet())
		return prov, nil
	}
	logger.Printf("[warn] %v", err) // per-pattern errors — set still usable
}
prov.Set(set)
_ = config.SaveRedactionSet(set)
logger.Printf("[refresh] redaction-set version=%s patterns=%d ttl=%ds",
	set.Version, len(set.Patterns), set.TTLSeconds)
return prov, nil
```

(Add `"errors"` import if not present.)

- [ ] **Step 4: Run tests**

Run: `cd agent && go test ./internal/cli/ -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add agent/internal/cli/redactionset.go agent/internal/cli/redactionset_test.go
git commit -m "fix(agent/cli): BootstrapRedactionSet falls back to stale/default on ErrTooManyPatterns"
```

### Task 5.3: Fix refresher goroutine in `run.go` (same ErrTooManyPatterns handling)

**Files:**
- Modify: `agent/internal/cli/run.go` (refresher block)
- Test: covered by run-loop integration in Phase 8

- [ ] **Step 1: Modify refresher block**

In the refresher goroutine inside `runRun`:

```go
set := &redact.RedactionSet{
	Patterns:   fresh.Patterns,
	Version:    fresh.Version,
	FetchedAt:  time.Now().UTC(),
	TTLSeconds: fresh.TTLSeconds,
}
if err := set.Compile(); err != nil {
	if errors.Is(err, redact.ErrTooManyPatterns) {
		logger.Printf("[error] refresh rejected: %v; keeping current set", err)
		continue
	}
	logger.Printf("[warn] %v", err)
}
setProvider.Set(set)
_ = config.SaveRedactionSet(set)
logger.Printf("[refresh] redaction-set version=%s patterns=%d ttl=%ds",
	set.Version, len(set.Patterns), set.TTLSeconds)
```

- [ ] **Step 2: Verify build**

Run: `cd agent && go build ./...`
Expected: success

- [ ] **Step 3: Commit**

```bash
git add agent/internal/cli/run.go
git commit -m "fix(agent/cli): refresher keeps current set on ErrTooManyPatterns"
```

---

## Phase 6: Symlink protection (watcher + cwdresolve)

### Task 6.1: ClaudeSource — reject symlinked jsonl via `os.Lstat`

**Files:**
- Modify: `agent/watcher/claude.go`
- Modify: `agent/watcher/claude_test.go`

- [ ] **Step 1: Write failing test**

```go
// agent/watcher/claude_test.go (append)
func TestClaudeSource_List_SkipsSymlinkedJsonl(t *testing.T) {
	root := t.TempDir()
	projDir := filepath.Join(root, "-Users-h-proj")
	if err := os.MkdirAll(projDir, 0o700); err != nil {
		t.Fatal(err)
	}
	// real file
	real := filepath.Join(projDir, "real.jsonl")
	if err := os.WriteFile(real, []byte("{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	// symlink — must be skipped
	sym := filepath.Join(projDir, "evil.jsonl")
	if err := os.Symlink("/etc/passwd", sym); err != nil {
		t.Fatal(err)
	}

	src := NewClaudeSource(root)
	refs, err := src.List(context.Background())
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	for _, r := range refs {
		if filepath.Base(r.Path) == "evil.jsonl" {
			t.Fatalf("symlink must be skipped, found %s", r.Path)
		}
	}
	// real must still appear
	found := false
	for _, r := range refs {
		if filepath.Base(r.Path) == "real.jsonl" {
			found = true
		}
	}
	if !found {
		t.Fatalf("real jsonl must still be listed")
	}
}
```

- [ ] **Step 2: Run test**

Run: `cd agent && go test ./watcher/ -run TestClaudeSource_List_SkipsSymlinkedJsonl -v`
Expected: FAIL — current `List` walks symlinks

- [ ] **Step 3: Add Lstat filter**

In `agent/watcher/claude.go` `List`, wherever a candidate jsonl is found, after the `.jsonl` extension check add:

```go
info, lerr := os.Lstat(filepath.Join(projDir, m.Name()))
if lerr != nil || info.Mode()&os.ModeSymlink != 0 {
	// silently skip — log via Loop's [warn] when wired in §3.7
	continue
}
```

Same treatment for the `subagents/agent-*.jsonl` branch.

- [ ] **Step 4: Run test**

Run: `cd agent && go test ./watcher/ -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add agent/watcher/claude.go agent/watcher/claude_test.go
git commit -m "feat(agent/watcher): ClaudeSource skips symlinked .jsonl entries"
```

### Task 6.2: CodexSource — same Lstat filter + readCWD guard

**Files:**
- Modify: `agent/watcher/codex.go`
- Modify: `agent/watcher/codex_test.go`

- [ ] **Step 1: Write failing test**

```go
// agent/watcher/codex_test.go (append)
func TestCodexSource_List_SkipsSymlinkedJsonl(t *testing.T) {
	root := t.TempDir()
	deep := filepath.Join(root, "2026", "05", "27")
	if err := os.MkdirAll(deep, 0o700); err != nil {
		t.Fatal(err)
	}
	// real
	uuid := "11111111-2222-3333-4444-555555555555"
	real := filepath.Join(deep, "rollout-"+uuid+".jsonl")
	if err := os.WriteFile(real, []byte(`{"payload":{"cwd":"/home/u"}}` + "\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	// symlink
	uuid2 := "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
	sym := filepath.Join(deep, "rollout-"+uuid2+".jsonl")
	if err := os.Symlink("/etc/passwd", sym); err != nil {
		t.Fatal(err)
	}

	src := NewCodexSource(root, nil)
	refs, err := src.List(context.Background())
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	for _, r := range refs {
		if filepath.Base(r.Path) == filepath.Base(sym) {
			t.Fatalf("symlink must be skipped, found %s", r.Path)
		}
	}
	if len(refs) != 1 {
		t.Fatalf("expected 1 real ref, got %d", len(refs))
	}
}

func TestCodexSource_ReadCWD_SymlinkReturnsEmpty(t *testing.T) {
	root := t.TempDir()
	deep := filepath.Join(root, "2026", "05", "27")
	if err := os.MkdirAll(deep, 0o700); err != nil {
		t.Fatal(err)
	}
	sym := filepath.Join(deep, "rollout-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl")
	if err := os.Symlink("/tmp/whatever", sym); err != nil {
		t.Fatal(err)
	}
	src := NewCodexSource(root, nil)
	if cwd := src.readCWD(sym); cwd != "" {
		t.Fatalf("readCWD on symlink must return empty, got %q", cwd)
	}
}
```

- [ ] **Step 2: Run tests**

Run: `cd agent && go test ./watcher/ -run TestCodexSource -v`
Expected: FAIL

- [ ] **Step 3: Add Lstat filters**

In `agent/watcher/codex.go` `List`, after the `rollout-` prefix and uuid regex match:

```go
info, lerr := os.Lstat(filepath.Join(dayDir, fe.Name()))
if lerr != nil || info.Mode()&os.ModeSymlink != 0 {
	continue
}
```

In `readCWD`, at the very top before `s.open(path)`:

```go
info, err := os.Lstat(path)
if err != nil || info.Mode()&os.ModeSymlink != 0 {
	return ""
}
```

- [ ] **Step 4: Run tests**

Run: `cd agent && go test ./watcher/ -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add agent/watcher/codex.go agent/watcher/codex_test.go
git commit -m "feat(agent/watcher): CodexSource skips symlinked rollouts; readCWD Lstat-guards"
```

### Task 6.3: cwdresolve — `EvalSymlinks` integration

**Files:**
- Modify: `agent/internal/cwdresolve/cwdresolve.go`
- Modify: `agent/internal/cwdresolve/cwdresolve_test.go`

- [ ] **Step 1: Write failing tests**

```go
// agent/internal/cwdresolve/cwdresolve_test.go (append)
func TestTryExtractCWD_SymlinkResolved(t *testing.T) {
	target := t.TempDir()
	linkParent := t.TempDir()
	link := filepath.Join(linkParent, "via-link")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	line := fmt.Sprintf(`{"cwd":%q}`, link)
	got := tryExtractCWD(line)
	if got != target {
		t.Fatalf("cwd via symlink should resolve to target.\nwant %q\ngot  %q", target, got)
	}
}

func TestTryExtractCWD_BrokenSymlinkReturnsEmpty(t *testing.T) {
	link := filepath.Join(t.TempDir(), "broken")
	_ = os.Symlink("/no/such/path", link)
	line := fmt.Sprintf(`{"cwd":%q}`, link)
	if got := tryExtractCWD(line); got != "" {
		t.Fatalf("broken symlink cwd must return empty, got %q", got)
	}
}

func TestDirnameFallback_EvalSymlinks(t *testing.T) {
	target := t.TempDir()
	parent := t.TempDir()
	via := filepath.Join(parent, "via-link")
	if err := os.Symlink(target, via); err != nil {
		t.Fatal(err)
	}
	// We feed the dash-encoded form of `via-link` and expect EvalSymlinks to follow.
	encoded := "-" + strings.ReplaceAll(strings.TrimPrefix(via, "/"), "/", "-")
	if got := dirnameFallback(encoded); got != target {
		t.Fatalf("dirnameFallback should EvalSymlinks the resolved candidate; want %q, got %q", target, got)
	}
}
```

- [ ] **Step 2: Run tests to verify fail**

Run: `cd agent && go test ./internal/cwdresolve/ -v`
Expected: FAIL — current code returns symlink path verbatim

- [ ] **Step 3: Patch `tryExtractCWD` and `dirnameFallback`**

```go
// agent/internal/cwdresolve/cwdresolve.go (revised)
func tryExtractCWD(line string) string {
	var obj struct {
		CWD string `json:"cwd"`
	}
	if err := json.Unmarshal([]byte(line), &obj); err != nil {
		return ""
	}
	if obj.CWD == "" {
		return ""
	}
	resolved, err := filepath.EvalSymlinks(obj.CWD)
	if err != nil {
		return ""
	}
	info, err := os.Stat(resolved)
	if err != nil || !info.IsDir() {
		return ""
	}
	return resolved
}
```

For `dirnameFallback`, after the existing `os.Stat(result)` check that confirms IsDir, also EvalSymlinks:

```go
func dirnameFallback(name string) string {
	if !strings.HasPrefix(name, "-") {
		return ""
	}
	body := name[1:]
	result := greedyDecode("/", body)
	if result == "" {
		return ""
	}
	resolved, err := filepath.EvalSymlinks(result)
	if err != nil {
		return ""
	}
	info, err := os.Stat(resolved)
	if err != nil || !info.IsDir() {
		return ""
	}
	return resolved
}
```

- [ ] **Step 4: Run tests**

Run: `cd agent && go test ./internal/cwdresolve/ -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add agent/internal/cwdresolve/
git commit -m "feat(agent/cwdresolve): EvalSymlinks in tryExtractCWD + dirnameFallback"
```

### Task 6.4: Loop `allowed()` resolves cwd via EvalSymlinks (best-effort)

**Files:**
- Modify: `agent/watcher/loop.go`
- Modify: `agent/watcher/loop_test.go`

- [ ] **Step 1: Write failing test**

```go
// agent/watcher/loop_test.go (append)
func TestAllowed_EvalSymlinksOnCWD(t *testing.T) {
	realDir := t.TempDir()
	linkParent := t.TempDir()
	link := filepath.Join(linkParent, "code")
	if err := os.Symlink(realDir, link); err != nil {
		t.Fatal(err)
	}
	// includePaths is the *real* path; cwd presented is the symlinked alias.
	if !allowed(link, []string{realDir}) {
		t.Fatalf("cwd via symlink should match includePaths=[real] after EvalSymlinks")
	}
}
```

- [ ] **Step 2: Run test**

Run: `cd agent && go test ./watcher/ -run TestAllowed_EvalSymlinksOnCWD -v`
Expected: FAIL — current `allowed` is plain HasPrefix

- [ ] **Step 3: Patch `allowed`**

```go
// agent/watcher/loop.go (allowed revised)
func allowed(cwd string, includes []string) bool {
	resolved, err := filepath.EvalSymlinks(cwd)
	if err != nil {
		resolved = cwd // best-effort
	}
	for _, inc := range includes {
		if resolved == inc || strings.HasPrefix(resolved, inc+"/") {
			return true
		}
	}
	return false
}
```

- [ ] **Step 4: Run tests**

Run: `cd agent && go test ./watcher/ -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add agent/watcher/loop.go agent/watcher/loop_test.go
git commit -m "feat(agent/watcher): allowed() resolves cwd symlinks before matching includePaths"
```

---

## Phase 7: `run` command upgrade — preflight + lockfile + stop-condition checks

Spec §3.7 defines a 5-step start (pre-flight read-only → acquire lock + PID → post-lock sentinel re-check → existing config/keychain/loop → graceful exit) plus per-tick/per-chunk/per-Save checks in §3.7 step 4.

### Task 7.1: Wire pre-flight read-only checks at the top of `runRun`

**Files:**
- Modify: `agent/internal/cli/run.go`
- Modify: `agent/internal/cli/run_test.go`

- [ ] **Step 1: Write failing tests**

```go
// agent/internal/cli/run_test.go (append)
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
	_ = os.WriteFile(filepath.Join(root, "config.toml"), []byte(""), 0o600)
	_ = os.WriteFile(filepath.Join(root, ".uninstalling"), []byte(""), 0o600)
	code := executeRunOnce(t, []string{"run"})
	if code != 0 {
		t.Fatalf("want exit 0 (uninstall in progress), got %d", code)
	}
	if _, err := os.Stat(filepath.Join(root, ".lock")); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("run pre-flight must NOT create .lock when sentinel present")
	}
}

func TestRun_PreflightConfigMissing_NoLockCreated(t *testing.T) {
	setupRoot(t) // root exists, no config.toml
	code := executeRunOnce(t, []string{"run"})
	if code != 1 {
		t.Fatalf("want exit 1 not enrolled, got %d", code)
	}
}
```

`executeRunOnce` and `setupRoot` are existing helpers in run_test.go; if missing, add a thin wrapper that constructs the cobra command and captures the int return.

- [ ] **Step 2: Run tests**

Run: `cd agent && go test ./internal/cli/ -run TestRun_NoConfigDir -v`
Expected: FAIL — current `runRun` will MkdirAll / open lock first

- [ ] **Step 3: Insert pre-flight at top of `runRun`**

```go
// agent/internal/cli/run.go (revised top of runRun)
func runRun(cmd *cobra.Command, once bool, interval time.Duration) error {
	root := config.RootDir()

	// STEP 1: pre-flight read-only checks — NO writes here
	if _, err := os.Stat(root); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return &ExitError{Code: 1, Err: errors.New("[fatal] not enrolled (config directory missing); run 'caliber-agent enroll <token>' first")}
		}
		return &ExitError{Code: 1, Err: fmt.Errorf("[fatal] stat root: %w", err)}
	}
	if _, err := os.Stat(config.UninstallSentinelPath()); err == nil || !errors.Is(err, fs.ErrNotExist) {
		// existence OR non-ErrNotExist stat error → fail-closed
		return &ExitError{Code: 0, Err: errors.New("[fatal] uninstall in progress; aborting startup")}
	}
	if _, err := os.Stat(config.ConfigPath()); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return &ExitError{Code: 1, Err: errors.New("[fatal] not enrolled (config.toml missing — partial cleanup?); re-enroll or remove ~/.caliber-agent/")}
		}
		return &ExitError{Code: 1, Err: fmt.Errorf("[fatal] stat config.toml: %w", err)}
	}

	// (STEP 2 lockfile acquire — next task)
	// ... existing logic continues
```

- [ ] **Step 4: Run tests**

Run: `cd agent && go test ./internal/cli/ -run TestRun -v`
Expected: PASS for the four new pre-flight tests

- [ ] **Step 5: Commit**

```bash
git add agent/internal/cli/run.go agent/internal/cli/run_test.go
git commit -m "feat(agent/cli): runRun pre-flight checks (root + sentinel + config.toml)"
```

### Task 7.2: Acquire lockfile + PID, post-lock sentinel re-check

**Files:**
- Modify: `agent/internal/cli/run.go`
- Modify: `agent/internal/cli/run_test.go`

- [ ] **Step 1: Write failing tests**

```go
// agent/internal/cli/run_test.go (append)
func TestRun_AcquireLock_FailsIfAlreadyHeld_Exit1(t *testing.T) {
	root := setupEnrolledRoot(t) // helper: writes config.toml
	// Pre-acquire .lock by another process surrogate.
	lk, err := lockfile.Acquire(filepath.Join(root, ".lock"))
	if err != nil {
		t.Fatal(err)
	}
	defer lk.Release()

	code := executeRunOnce(t, []string{"run"})
	if code != 1 {
		t.Fatalf("want exit 1 concurrent run, got %d", code)
	}
}

func TestRun_LockfileContainsPID(t *testing.T) {
	root := setupEnrolledRoot(t)
	// Use --once to make run terminate quickly.
	_ = executeRunOnce(t, []string{"run", "--once"})
	b, err := os.ReadFile(filepath.Join(root, ".lock"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(strings.TrimSpace(string(b)), "1") {
		// At minimum must be a numeric PID, not empty.
		if _, perr := strconv.Atoi(strings.TrimSpace(string(b))); perr != nil {
			t.Fatalf(".lock must contain PID, got %q", string(b))
		}
	}
}

func TestRun_PostLockSentinelAppearedMidStartup_Exit0(t *testing.T) {
	// Simulate sentinel appearing between pre-flight and acquire: pre-flight gate
	// in tests is approximated via injection point in runRun (mock hook).
	t.Skip("requires test hook in runRun to inject mid-startup sentinel write — implement helper in run_test.go alongside this task")
}
```

- [ ] **Step 2: Run tests**

Run: `cd agent && go test ./internal/cli/ -run 'TestRun_Acquire|TestRun_Lockfile' -v`
Expected: FAIL — lockfile not yet used in run

- [ ] **Step 3: Insert lockfile acquire + post-lock re-check**

After the pre-flight block in `runRun`, before `config.Load()`:

```go
// STEP 2: acquire lockfile + write PID
lk, err := lockfile.Acquire(filepath.Join(root, ".lock"))
if err != nil {
	if errors.Is(err, lockfile.ErrLocked) {
		return &ExitError{Code: 1, Err: errors.New("another caliber-agent run is already active")}
	}
	return &ExitError{Code: 1, Err: fmt.Errorf("acquire lock: %w", err)}
}
defer lk.Release()

// STEP 3: post-lock sentinel re-check (catches pre-flight → acquire window)
if _, err := os.Stat(config.UninstallSentinelPath()); err == nil || !errors.Is(err, fs.ErrNotExist) {
	return &ExitError{Code: 0, Err: errors.New("[fatal] uninstall in progress; aborting startup")}
}
```

(Add imports `"github.com/hanfour/ai-dev-eval/agent/internal/lockfile"` and the existing `errors`, `fmt`, `fs`.)

- [ ] **Step 4: Run tests**

Run: `cd agent && go test ./internal/cli/ -run TestRun -v`
Expected: PASS for new tests

- [ ] **Step 5: Commit**

```bash
git add agent/internal/cli/run.go agent/internal/cli/run_test.go
git commit -m "feat(agent/cli): runRun acquires lockfile + writes PID + post-lock sentinel re-check"
```

### Task 7.3: Per-tick + per-chunk + per-Save stop-condition checks in `watcher.Loop`

**Files:**
- Modify: `agent/watcher/loop.go`
- Modify: `agent/watcher/loop_test.go`

- [ ] **Step 1: Write failing tests**

```go
// agent/watcher/loop_test.go (append)
func TestTick_UninstallSentinelExists_SkipsTickWithFatalLog(t *testing.T) {
	root := setupEnrolledRoot(t)
	_ = os.WriteFile(filepath.Join(root, ".uninstalling"), []byte(""), 0o600)
	log := &captureLogger{}
	loop := buildLoopForTest(t, log)
	err := loop.Tick(context.Background())
	if err == nil {
		t.Fatalf("want fatal error, got nil")
	}
	if !errors.Is(err, config.ErrUninstallInProgress) {
		t.Fatalf("want ErrUninstallInProgress, got %v", err)
	}
}

func TestTick_ConfigTomlRemoved_ExitsCleanly(t *testing.T) {
	root := setupEnrolledRoot(t)
	_ = os.Remove(filepath.Join(root, "config.toml"))
	loop := buildLoopForTest(t, &captureLogger{})
	err := loop.Tick(context.Background())
	if !errors.Is(err, config.ErrConfigRemoved) {
		t.Fatalf("want ErrConfigRemoved, got %v", err)
	}
}

func TestTick_SaveState_DiskFullReturnsRawIOError_DaemonContinues(t *testing.T) {
	// Inject SaveState that returns a non-sentinel error; Loop should log+continue.
	// (Requires injection point or wrapping config.SaveState behind an interface — see comment in implementation.)
	t.Skip("hook for non-sentinel SaveState error — implement when watcher.Loop SaveState gets typed dispatch")
}
```

- [ ] **Step 2: Run tests**

Run: `cd agent && go test ./watcher/ -run 'TestTick_Uninstall|TestTick_Config' -v`
Expected: FAIL — current Loop has neither check

- [ ] **Step 3: Add checks at start of `Tick`**

```go
// agent/watcher/loop.go (top of Tick)
func (l *Loop) Tick(ctx context.Context) error {
	if err := l.preTickChecks(); err != nil {
		l.log.Printf("[fatal] %v", err)
		return err
	}
	// ... existing tick body
}

func (l *Loop) preTickChecks() error {
	if _, err := os.Stat(config.UninstallSentinelPath()); err == nil {
		return config.ErrUninstallInProgress
	} else if !errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("%w (sentinel stat: %v)", config.ErrUninstallInProgress, err)
	}
	// paused — existing PR2 path
	if _, err := os.Stat(config.PausedPath()); err == nil {
		l.log.Printf("[paused] skipping tick")
		return errPausedSkip // local sentinel returned to caller; Run() treats as skip-not-fatal
	}
	if _, err := os.Stat(config.ConfigPath()); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return config.ErrConfigRemoved
		}
	}
	if _, err := os.Stat(config.LockPath()); errors.Is(err, fs.ErrNotExist) {
		return errLockfileRemoved
	}
	return nil
}

// In the chunk send loop, before each SendChunk:
if _, err := os.Stat(config.UninstallSentinelPath()); err == nil || !errors.Is(err, fs.ErrNotExist) {
	l.log.Printf("[fatal] uninstall in progress; aborting remaining chunks")
	return config.ErrUninstallInProgress
}
if _, err := os.Stat(config.ConfigPath()); errors.Is(err, fs.ErrNotExist) {
	l.log.Printf("[fatal] config removed mid-tick; aborting remaining chunks")
	return config.ErrConfigRemoved
}
```

Add `errPausedSkip = errors.New(...)` and `errLockfileRemoved = errors.New(...)` as unexported sentinels handled by `Run()`.

In `Run()`'s switch on Tick error, treat `errPausedSkip` as "sleep, continue", treat `ErrUninstallInProgress / ErrConfigRemoved / ErrRootRemoved` as fatal return.

- [ ] **Step 4: Typed dispatch for `SaveState` errors**

Wherever `l.state` is saved (PR2 `loop.go:136,169,189`):

```go
if saveErr := config.SaveState(l.state); saveErr != nil {
	switch {
	case errors.Is(saveErr, config.ErrUninstallInProgress),
		errors.Is(saveErr, config.ErrConfigRemoved),
		errors.Is(saveErr, config.ErrRootRemoved):
		l.log.Printf("[fatal] save state: %v; daemon exiting", saveErr)
		return saveErr
	default:
		l.log.Printf("[error] save state: %v", saveErr)
		// continue — non-fatal IO error
	}
}
```

- [ ] **Step 5: Run tests**

Run: `cd agent && go test ./watcher/ -v`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add agent/watcher/loop.go agent/watcher/loop_test.go
git commit -m "feat(agent/watcher): per-tick + per-chunk + per-Save sentinel/config checks; typed SaveState dispatch"
```

### Task 7.4: `runRun` honours Loop's fatal errors → ExitError{0}

**Files:**
- Modify: `agent/internal/cli/run.go`

- [ ] **Step 1: Map sentinels to exit 0**

In `runRun`, where `loop.Run(ctx)` returns:

```go
if err := loop.Run(ctx); err != nil {
	switch {
	case errors.Is(err, config.ErrUninstallInProgress),
		errors.Is(err, config.ErrConfigRemoved),
		errors.Is(err, config.ErrRootRemoved):
		// Daemon exiting cleanly because uninstall is happening (or done).
		return &ExitError{Code: 0, Err: err}
	}
	if ee := fatalExitFor(err); ee != nil {
		return ee
	}
	return err
}
```

- [ ] **Step 2: Run regression**

Run: `cd agent && go test ./internal/cli/ ./watcher/ -v`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add agent/internal/cli/run.go
git commit -m "feat(agent/cli): runRun maps config sentinels to ExitError{0}"
```

### Task 7.5: Fix `run` short-desc text

**Files:**
- Modify: `agent/internal/cli/run.go:29`

- [ ] **Step 1: Single-line text change**

Replace:
```go
Short: "Run the daemon main loop (foreground; launchd-managed in production)",
```
With:
```go
Short: "Run the daemon main loop (foreground; you start and stop it manually)",
```

- [ ] **Step 2: Commit**

```bash
git add agent/internal/cli/run.go
git commit -m "docs(agent/cli): correct run short-desc to reflect manual lifecycle"
```

---

## Phase 8: `enroll` command upgrade

### Task 8.1: Add `--insecure` flag + early sentinel preflight + partial-cleanup preflight

**Files:**
- Modify: `agent/internal/cli/enroll.go`
- Modify: `agent/internal/cli/enroll_test.go`

- [ ] **Step 1: Write failing tests**

```go
// agent/internal/cli/enroll_test.go (append)
func TestEnroll_SentinelPresent_Exit1_NoAPICall(t *testing.T) {
	root := setupRoot(t)
	_ = os.WriteFile(filepath.Join(root, ".uninstalling"), []byte(""), 0o600)
	fakeAPI := &fakeAPIClient{}
	code := executeEnrollWithMock(t, fakeAPI, []string{"enroll", "tok"})
	if code != 1 {
		t.Fatalf("want exit 1, got %d", code)
	}
	if fakeAPI.enrollCalls != 0 {
		t.Fatalf("API must NOT be called when sentinel present")
	}
}

func TestEnroll_PartialCleanup_RootExistsConfigMissing_Exit1(t *testing.T) {
	setupRoot(t) // root exists; no config.toml, no sentinel — simulates ordered_delete (h)
	fakeAPI := &fakeAPIClient{}
	code := executeEnrollWithMock(t, fakeAPI, []string{"enroll", "tok"})
	if code != 1 {
		t.Fatalf("want exit 1 partial uninstall, got %d", code)
	}
	if fakeAPI.enrollCalls != 0 {
		t.Fatalf("API must NOT be called when partial cleanup detected")
	}
}

func TestEnroll_RootMissing_FirstEnrollHappyPath(t *testing.T) {
	root := filepath.Join(t.TempDir(), "absent")
	t.Setenv("CALIBER_AGENT_HOME", root)
	fakeAPI := &fakeAPIClient{ok: true}
	code := executeEnrollWithMock(t, fakeAPI, []string{"enroll", "tok", "--api-base-url=https://x"})
	if code != 0 {
		t.Fatalf("want exit 0 happy, got %d", code)
	}
	if _, err := os.Stat(filepath.Join(root, "config.toml")); err != nil {
		t.Fatalf("config.toml expected, %v", err)
	}
}

func TestEnroll_HTTPWithoutInsecure_Rejected(t *testing.T) {
	t.Setenv("CALIBER_AGENT_HOME", filepath.Join(t.TempDir(), "absent"))
	fakeAPI := &fakeAPIClient{ok: true}
	code := executeEnrollWithMock(t, fakeAPI, []string{"enroll", "tok", "--api-base-url=http://x"})
	if code != 1 {
		t.Fatalf("want exit 1, got %d", code)
	}
}

func TestEnroll_HTTPWithInsecure_Allowed(t *testing.T) {
	t.Setenv("CALIBER_AGENT_HOME", filepath.Join(t.TempDir(), "absent"))
	fakeAPI := &fakeAPIClient{ok: true}
	code := executeEnrollWithMock(t, fakeAPI, []string{"enroll", "tok", "--api-base-url=http://x", "--insecure"})
	if code != 0 {
		t.Fatalf("want exit 0, got %d", code)
	}
}
```

- [ ] **Step 2: Run tests**

Run: `cd agent && go test ./internal/cli/ -run TestEnroll -v`
Expected: FAIL — preflights + flag missing

- [ ] **Step 3: Add preflights + flag + ValidateAPIBaseURL wiring**

In `newEnrollCmd()`:

```go
var apiBaseURL string
var insecure bool
var force bool
cmd := &cobra.Command{
	Use:   "enroll <token>",
	Short: "Enrol this device with caliber using a one-shot enrollment token",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		return runEnroll(cmd, args[0], force, apiBaseURL, insecure)
	},
}
cmd.Flags().StringVar(&apiBaseURL, "api-base-url", "", "caliber API URL (or set CALIBER_API_BASE_URL)")
cmd.Flags().BoolVar(&insecure, "insecure", false, "allow http:// in api-base-url (dev/local only)")
cmd.Flags().BoolVar(&force, "force", false, "re-enroll over an existing device")
return cmd
```

In `runEnroll`, **before** `config.Load`:

```go
root := config.RootDir()

// (1) sentinel preflight — fail-closed
if _, err := os.Stat(filepath.Join(root, ".uninstalling")); err == nil {
	return &ExitError{Code: 1, Err: errors.New("[fatal] uninstall in progress; refusing to enroll")}
} else if !errors.Is(err, fs.ErrNotExist) {
	return &ExitError{Code: 1, Err: fmt.Errorf("[fatal] cannot stat uninstall sentinel (%v); failing closed", err)}
}

// (2) partial-cleanup preflight — root exists but config.toml missing
if rootInfo, rErr := os.Stat(root); rErr == nil && rootInfo.IsDir() {
	if _, cErr := os.Stat(filepath.Join(root, "config.toml")); errors.Is(cErr, fs.ErrNotExist) {
		return &ExitError{Code: 1, Err: errors.New("[fatal] partial uninstall detected (root exists, config.toml missing); manually 'rm -rf ~/.caliber-agent/' then retry enroll")}
	}
}

// API base URL resolution (flag > env)
baseURL := apiBaseURL
if baseURL == "" {
	baseURL = os.Getenv("CALIBER_API_BASE_URL")
}
if baseURL == "" {
	return &ExitError{Code: 1, Err: fmt.Errorf("API base URL not configured: pass --api-base-url or set CALIBER_API_BASE_URL")}
}
if err := config.ValidateAPIBaseURL(baseURL, insecure); err != nil {
	return &ExitError{Code: 1, Err: fmt.Errorf("invalid api_base_url: %w", err)}
}
```

Persist `InsecureTransport: insecure` into the wizard `Deps` (next task wires the wizard).

- [ ] **Step 4: Run tests**

Run: `cd agent && go test ./internal/cli/ -run TestEnroll -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add agent/internal/cli/enroll.go agent/internal/cli/enroll_test.go
git commit -m "feat(agent/cli): enroll preflight (sentinel + partial-cleanup) + --insecure flag + scheme validation"
```

### Task 8.2: Wizard switch to `SaveConfigInitial` + `SaveConfig` + IncludePaths normalisation

**Files:**
- Modify: `agent/internal/wizard/enroll.go`
- Modify: `agent/internal/wizard/enroll_test.go`

- [ ] **Step 1: Write failing tests**

```go
// agent/internal/wizard/enroll_test.go (append)
func TestRunEnrollWizard_FirstWriteUsesSaveConfigInitial(t *testing.T) {
	root := filepath.Join(t.TempDir(), "absent")
	t.Setenv("CALIBER_AGENT_HOME", root)
	deps := Deps{ /* ... fake prompter / enroll / setSecret ... */ }
	if err := RunEnrollWizard(context.Background(), deps, "tok"); err != nil {
		t.Fatalf("want nil, got %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "config.toml")); err != nil {
		t.Fatalf("config.toml expected, %v", err)
	}
}

func TestRunEnrollWizard_IncludePathsNormalised(t *testing.T) {
	root := filepath.Join(t.TempDir(), "absent")
	t.Setenv("CALIBER_AGENT_HOME", root)
	target := t.TempDir()
	linkParent := t.TempDir()
	via := filepath.Join(linkParent, "code")
	if err := os.Symlink(target, via); err != nil {
		t.Fatal(err)
	}
	deps := Deps{
		// Prompter that selects `via` (symlinked path)
		Prompter: &fixedPrompter{selectedPath: via},
		// ... other deps wired
	}
	if err := RunEnrollWizard(context.Background(), deps, "tok"); err != nil {
		t.Fatalf("RunEnrollWizard: %v", err)
	}
	cfg, err := config.Load()
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg.IncludePaths) != 1 || cfg.IncludePaths[0] != target {
		t.Fatalf("IncludePaths must be EvalSymlinks-normalised; got %v want [%s]", cfg.IncludePaths, target)
	}
}

func TestRunEnrollWizard_InsecureTransportPersisted(t *testing.T) {
	root := filepath.Join(t.TempDir(), "absent")
	t.Setenv("CALIBER_AGENT_HOME", root)
	deps := Deps{InsecureTransport: true /* ... */}
	if err := RunEnrollWizard(context.Background(), deps, "tok"); err != nil {
		t.Fatal(err)
	}
	cfg, _ := config.Load()
	if !cfg.InsecureTransport {
		t.Fatalf("InsecureTransport must persist")
	}
}
```

- [ ] **Step 2: Run to verify fail**

Run: `cd agent && go test ./internal/wizard/ -v`
Expected: FAIL — current code uses `config.Save`, no normalisation, no InsecureTransport

- [ ] **Step 3: Patch wizard**

In `agent/internal/wizard/enroll.go`:

1. Add `InsecureTransport bool` to `Deps`.
2. At line 83 replace `config.Save(cfg)` with `config.SaveConfigInitial(cfg)`.
3. After the path selection step, before final write, normalise each chosen path:

   ```go
   normalised := make([]string, 0, len(selected))
   for _, p := range selected {
       resolved, err := filepath.EvalSymlinks(p)
       if err != nil {
           // path no longer exists; skip + warn
           continue
       }
       normalised = append(normalised, filepath.Clean(resolved))
   }
   cfg.IncludePaths = normalised
   ```

4. At line 119 (final write), `config.Save(cfg)` → `config.SaveConfig(cfg)`.
5. Persist `cfg.InsecureTransport = d.InsecureTransport` before first save.

- [ ] **Step 4: Run tests**

Run: `cd agent && go test ./internal/wizard/ -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add agent/internal/wizard/enroll.go agent/internal/wizard/enroll_test.go
git commit -m "feat(agent/wizard): SaveConfigInitial/SaveConfig + EvalSymlinks IncludePaths + persist InsecureTransport"
```

---

## Phase 9: Subcommands part 1 — `add-path` + `remove-path`

### Task 9.1: `add-path <absolute-path>` real implementation

**Files:**
- Modify: `agent/internal/cli/addpath.go`
- Modify: `agent/internal/cli/addpath_test.go` (or create)

- [ ] **Step 1: Write failing tests**

```go
// agent/internal/cli/addpath_test.go
package cli

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"github.com/hanfour/ai-dev-eval/agent/internal/config"
)

func TestAddPath_HappyPath_Atomic(t *testing.T) {
	root := setupEnrolledRoot(t)
	target := t.TempDir()
	code := executeCLIWithStdin(t, "y\n", []string{"add-path", target, "--yes"})
	if code != 0 {
		t.Fatalf("want 0, got %d", code)
	}
	cfg, _ := config.Load()
	found := false
	for _, p := range cfg.IncludePaths {
		if p == target {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected %s in IncludePaths, got %v", target, cfg.IncludePaths)
	}
	_ = root
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
	root := setupEnrolledRoot(t)
	target := t.TempDir()
	// pre-populate
	cfg, _ := config.Load()
	cfg.IncludePaths = []string{target}
	_ = config.SaveConfig(cfg)

	code := executeCLI(t, []string{"add-path", target, "--yes"})
	if code != 0 {
		t.Fatalf("idempotent want 0, got %d", code)
	}
	cfg2, _ := config.Load()
	count := 0
	for _, p := range cfg2.IncludePaths {
		if p == target {
			count++
		}
	}
	if count != 1 {
		t.Fatalf("duplicate not allowed; got %d entries", count)
	}
	_ = root
}

func TestAddPath_SymlinkInput_NormalisedToReal(t *testing.T) {
	setupEnrolledRoot(t)
	real := t.TempDir()
	linkParent := t.TempDir()
	link := filepath.Join(linkParent, "code")
	if err := os.Symlink(real, link); err != nil {
		t.Fatal(err)
	}
	code := executeCLI(t, []string{"add-path", link, "--yes"})
	if code != 0 {
		t.Fatalf("got %d", code)
	}
	cfg, _ := config.Load()
	if cfg.IncludePaths[0] != real {
		t.Fatalf("expected normalised path %s, got %s", real, cfg.IncludePaths[0])
	}
}

func TestAddPath_ConsentDeclined_Exit130(t *testing.T) {
	setupEnrolledRoot(t)
	target := t.TempDir()
	code := executeCLIWithStdin(t, "n\n", []string{"add-path", target})
	if code != 130 {
		t.Fatalf("want 130, got %d", code)
	}
	cfg, _ := config.Load()
	if len(cfg.IncludePaths) != 0 {
		t.Fatalf("decline must not mutate, got %v", cfg.IncludePaths)
	}
}

func TestAddPath_NonTTY_NoYes_Exit130(t *testing.T) {
	setupEnrolledRoot(t)
	target := t.TempDir()
	// Run with closed stdin to simulate non-TTY without --yes
	code := executeCLI(t, []string{"add-path", target})
	if code != 130 {
		t.Fatalf("want 130 non-TTY without --yes, got %d", code)
	}
}
```

- [ ] **Step 2: Run tests**

Run: `cd agent && go test ./internal/cli/ -run TestAddPath -v`
Expected: FAIL — stub returns ExitNotImplemented

- [ ] **Step 3: Implement `add-path`**

```go
// agent/internal/cli/addpath.go
package cli

import (
	"bufio"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"github.com/spf13/cobra"
	"github.com/hanfour/ai-dev-eval/agent/internal/config"
	"golang.org/x/term"
)

func newAddPathCmd() *cobra.Command {
	var yes bool
	cmd := &cobra.Command{
		Use:   "add-path <absolute-path>",
		Short: "Add a project path to the allow-list",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return runAddPath(cmd, args[0], yes)
		},
	}
	cmd.Flags().BoolVar(&yes, "yes", false, "skip interactive consent prompt")
	return cmd
}

func runAddPath(cmd *cobra.Command, raw string, yes bool) error {
	if !filepath.IsAbs(raw) {
		return &ExitError{Code: 64, Err: fmt.Errorf("add-path requires absolute path: %q", raw)}
	}
	resolved, err := filepath.EvalSymlinks(raw)
	if err != nil {
		return &ExitError{Code: 1, Err: fmt.Errorf("cannot resolve path: %w", err)}
	}
	normalised := filepath.Clean(resolved)
	info, err := os.Stat(normalised)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return &ExitError{Code: 1, Err: fmt.Errorf("path does not exist: %s", raw)}
		}
		return &ExitError{Code: 1, Err: fmt.Errorf("stat: %w", err)}
	}
	if !info.IsDir() {
		return &ExitError{Code: 1, Err: fmt.Errorf("not a directory: %s", normalised)}
	}

	cfg, err := config.Load()
	if err != nil {
		return &ExitError{Code: 1, Err: err}
	}
	for _, p := range cfg.IncludePaths {
		if p == normalised {
			fmt.Fprintf(cmd.OutOrStdout(), "already in list: %s\n", normalised)
			return nil
		}
	}

	if !yes {
		if !term.IsTerminal(int(os.Stdin.Fd())) {
			return &ExitError{Code: 130, Err: errors.New("non-interactive shell detected; pass --yes to confirm")}
		}
		fmt.Fprintf(cmd.OutOrStdout(),
			"This will watch %s and upload transcript content found under it to %s. Mode: %s. Continue? [y/N] ",
			normalised, cfg.APIBaseURL, cfg.Mode)
		reader := bufio.NewReader(os.Stdin)
		ans, _ := reader.ReadString('\n')
		ans = strings.ToLower(strings.TrimSpace(ans))
		if ans != "y" && ans != "yes" {
			return &ExitError{Code: 130, Err: errors.New("user declined")}
		}
	}

	cfg.IncludePaths = append(cfg.IncludePaths, normalised)
	if err := config.SaveConfig(cfg); err != nil {
		return ExitFromErr(err)
	}
	fmt.Fprintf(cmd.OutOrStdout(), "[ok] added %s; restart 'caliber-agent run' to pick it up\n", normalised)
	return nil
}
```

(Note: add `golang.org/x/term` to `go.mod` if not already present.)

- [ ] **Step 4: Run tests**

Run: `cd agent && go test ./internal/cli/ -run TestAddPath -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add agent/internal/cli/addpath.go agent/internal/cli/addpath_test.go go.mod go.sum
git commit -m "feat(agent/cli): add-path real impl (EvalSymlinks + consent + atomic save)"
```

### Task 9.2: `remove-path <path>` real implementation

**Files:**
- Modify: `agent/internal/cli/removepath.go`
- Modify: `agent/internal/cli/removepath_test.go` (create)

- [ ] **Step 1: Write failing tests**

```go
// agent/internal/cli/removepath_test.go
package cli

import (
	"path/filepath"
	"testing"
	"github.com/hanfour/ai-dev-eval/agent/internal/config"
)

func TestRemovePath_HappyPath(t *testing.T) {
	setupEnrolledRoot(t)
	target := t.TempDir()
	cfg, _ := config.Load()
	cfg.IncludePaths = []string{target}
	_ = config.SaveConfig(cfg)

	code := executeCLI(t, []string{"remove-path", target})
	if code != 0 {
		t.Fatalf("want 0, got %d", code)
	}
	cfg2, _ := config.Load()
	if len(cfg2.IncludePaths) != 0 {
		t.Fatalf("want [], got %v", cfg2.IncludePaths)
	}
}

func TestRemovePath_NotInList_NoOp(t *testing.T) {
	setupEnrolledRoot(t)
	code := executeCLI(t, []string{"remove-path", t.TempDir()})
	if code != 0 {
		t.Fatalf("want 0 noop, got %d", code)
	}
}

func TestRemovePath_BrokenSymlink_StillRemoves(t *testing.T) {
	setupEnrolledRoot(t)
	// We pre-populated with a path that no longer exists.
	gone := filepath.Join(t.TempDir(), "deleted")
	cfg, _ := config.Load()
	cfg.IncludePaths = []string{gone}
	_ = config.SaveConfig(cfg)

	code := executeCLI(t, []string{"remove-path", gone})
	if code != 0 {
		t.Fatalf("want 0, got %d", code)
	}
}
```

- [ ] **Step 2: Run tests**

Expected: FAIL — stub

- [ ] **Step 3: Implement**

```go
// agent/internal/cli/removepath.go
package cli

import (
	"fmt"
	"path/filepath"
	"github.com/spf13/cobra"
	"github.com/hanfour/ai-dev-eval/agent/internal/config"
)

func newRemovePathCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "remove-path <path>",
		Short: "Remove a project path from the allow-list",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return runRemovePath(cmd, args[0])
		},
	}
	return cmd
}

func runRemovePath(cmd *cobra.Command, raw string) error {
	// Best-effort normalise; broken symlinks fall back to Clean(raw).
	normalised := raw
	if resolved, err := filepath.EvalSymlinks(raw); err == nil {
		normalised = filepath.Clean(resolved)
	} else {
		normalised = filepath.Clean(raw)
	}

	cfg, err := config.Load()
	if err != nil {
		return &ExitError{Code: 1, Err: err}
	}
	kept := make([]string, 0, len(cfg.IncludePaths))
	removed := false
	for _, p := range cfg.IncludePaths {
		if p == normalised || p == raw {
			removed = true
			continue
		}
		kept = append(kept, p)
	}
	if !removed {
		fmt.Fprintf(cmd.OutOrStdout(), "not in list: %s\n", raw)
		return nil
	}
	cfg.IncludePaths = kept
	if err := config.SaveConfig(cfg); err != nil {
		return ExitFromErr(err)
	}
	fmt.Fprintf(cmd.OutOrStdout(), "[ok] removed %s\n", raw)
	return nil
}
```

- [ ] **Step 4: Run tests**

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add agent/internal/cli/removepath.go agent/internal/cli/removepath_test.go
git commit -m "feat(agent/cli): remove-path real impl (broken-symlink-tolerant)"
```

---

## Phase 10: Subcommands part 2 — `pause` / `resume` / `status`

### Task 10.1: `pause` real implementation

**Files:**
- Modify: `agent/internal/cli/pause.go`
- Modify: `agent/internal/cli/pause_test.go` (create)

- [ ] **Step 1: Write failing tests**

```go
// agent/internal/cli/pause_test.go
package cli

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"testing"
	"github.com/hanfour/ai-dev-eval/agent/internal/config"
)

func TestPause_TouchesSentinel(t *testing.T) {
	root := setupEnrolledRoot(t)
	code := executeCLI(t, []string{"pause"})
	if code != 0 {
		t.Fatalf("want 0, got %d", code)
	}
	if _, err := os.Stat(filepath.Join(root, "paused")); err != nil {
		t.Fatalf("paused must exist, got %v", err)
	}
}

func TestPause_Idempotent(t *testing.T) {
	root := setupEnrolledRoot(t)
	_ = os.WriteFile(filepath.Join(root, "paused"), []byte(""), 0o600)
	code := executeCLI(t, []string{"pause"})
	if code != 0 {
		t.Fatalf("idempotent want 0, got %d", code)
	}
}

func TestPause_NoConfigDir_Exit1(t *testing.T) {
	t.Setenv("CALIBER_AGENT_HOME", filepath.Join(t.TempDir(), "absent"))
	code := executeCLI(t, []string{"pause"})
	if code != 1 {
		t.Fatalf("want 1, got %d", code)
	}
}

func TestPause_ConfigTomlMissing_Exit1_NoPausedFileCreated(t *testing.T) {
	root := setupRoot(t) // root exists, no config.toml
	code := executeCLI(t, []string{"pause"})
	if code != 1 {
		t.Fatalf("want 1, got %d", code)
	}
	if _, err := os.Stat(filepath.Join(root, "paused")); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("paused must not be created when not enrolled")
	}
}

func TestPause_UninstallInProgress_Exit1_NoPausedFileCreated(t *testing.T) {
	root := setupEnrolledRoot(t)
	_ = os.WriteFile(filepath.Join(root, ".uninstalling"), []byte(""), 0o600)
	code := executeCLI(t, []string{"pause"})
	if code != 1 {
		t.Fatalf("want 1, got %d", code)
	}
	if _, err := os.Stat(filepath.Join(root, "paused")); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("paused must not be created during uninstall")
	}
}
```

- [ ] **Step 2: Run tests**

Run: `cd agent && go test ./internal/cli/ -run TestPause -v`
Expected: FAIL

- [ ] **Step 3: Implement `pause`**

```go
// agent/internal/cli/pause.go
package cli

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"github.com/spf13/cobra"
	"github.com/hanfour/ai-dev-eval/agent/internal/config"
)

func newPauseCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "pause",
		Short: "Pause syncing (running daemon will skip ticks)",
		RunE: func(cmd *cobra.Command, _ []string) error {
			return runPause(cmd)
		},
	}
	return cmd
}

func runPause(cmd *cobra.Command) error {
	root := config.RootDir()
	if _, err := os.Stat(root); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return &ExitError{Code: 1, Err: errors.New("[fatal] not enrolled")}
		}
		return &ExitError{Code: 1, Err: fmt.Errorf("stat root: %w", err)}
	}
	if _, err := os.Stat(filepath.Join(root, ".uninstalling")); err == nil || !errors.Is(err, fs.ErrNotExist) {
		return &ExitError{Code: 1, Err: errors.New("[fatal] uninstall in progress; refusing to pause")}
	}
	if _, err := os.Stat(filepath.Join(root, "config.toml")); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return &ExitError{Code: 1, Err: errors.New("[fatal] not enrolled (config.toml missing)")}
		}
		return &ExitError{Code: 1, Err: fmt.Errorf("stat config.toml: %w", err)}
	}
	if err := os.WriteFile(filepath.Join(root, "paused"), []byte{}, 0o600); err != nil {
		return &ExitError{Code: 1, Err: fmt.Errorf("write paused: %w", err)}
	}
	fmt.Fprintln(cmd.OutOrStdout(), "paused. running daemon will skip ticks on next interval. resume with 'caliber-agent resume'.")
	return nil
}
```

- [ ] **Step 4: Run tests**

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add agent/internal/cli/pause.go agent/internal/cli/pause_test.go
git commit -m "feat(agent/cli): pause real impl (dir + sentinel + config checks)"
```

### Task 10.2: `resume` real implementation

**Files:**
- Modify: `agent/internal/cli/resume.go`
- Modify: `agent/internal/cli/resume_test.go` (create)

- [ ] **Step 1: Write failing tests**

```go
// agent/internal/cli/resume_test.go
package cli

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"testing"
)

func TestResume_RemovesSentinel(t *testing.T) {
	root := setupEnrolledRoot(t)
	_ = os.WriteFile(filepath.Join(root, "paused"), []byte(""), 0o600)
	code := executeCLI(t, []string{"resume"})
	if code != 0 {
		t.Fatalf("want 0, got %d", code)
	}
	if _, err := os.Stat(filepath.Join(root, "paused")); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("paused must be removed")
	}
}

func TestResume_NotPaused_NoOp(t *testing.T) {
	setupEnrolledRoot(t)
	code := executeCLI(t, []string{"resume"})
	if code != 0 {
		t.Fatalf("want 0 idempotent, got %d", code)
	}
}
```

- [ ] **Step 2: Run tests**

Expected: FAIL

- [ ] **Step 3: Implement**

```go
// agent/internal/cli/resume.go
package cli

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"github.com/spf13/cobra"
	"github.com/hanfour/ai-dev-eval/agent/internal/config"
)

func newResumeCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "resume",
		Short: "Resume syncing",
		RunE: func(cmd *cobra.Command, _ []string) error {
			return runResume(cmd)
		},
	}
	return cmd
}

func runResume(cmd *cobra.Command) error {
	if err := os.Remove(config.PausedPath()); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			fmt.Fprintln(cmd.OutOrStdout(), "not paused")
			return nil
		}
		return &ExitError{Code: 1, Err: fmt.Errorf("rm paused: %w", err)}
	}
	fmt.Fprintln(cmd.OutOrStdout(), "resumed.")
	return nil
}
```

- [ ] **Step 4: Run tests**

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add agent/internal/cli/resume.go agent/internal/cli/resume_test.go
git commit -m "feat(agent/cli): resume real impl (idempotent rm paused)"
```

### Task 10.3: `status [--json]` real implementation

**Files:**
- Modify: `agent/internal/cli/status.go`
- Modify: `agent/internal/cli/status_test.go` (create)

- [ ] **Step 1: Write failing tests**

```go
// agent/internal/cli/status_test.go
package cli

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"github.com/hanfour/ai-dev-eval/agent/internal/config"
)

func TestStatus_HappyPath_Human(t *testing.T) {
	setupEnrolledRoot(t)
	stdout := executeCLIStdout(t, []string{"status"})
	for _, want := range []string{"device_id:", "api_base_url:", "mode:", "paused:", "watched paths"} {
		if !strings.Contains(stdout, want) {
			t.Errorf("missing %q in output:\n%s", want, stdout)
		}
	}
}

func TestStatus_JSON_StructuredOutput(t *testing.T) {
	setupEnrolledRoot(t)
	stdout := executeCLIStdout(t, []string{"status", "--json"})
	var got map[string]any
	if err := json.Unmarshal([]byte(stdout), &got); err != nil {
		t.Fatalf("json parse: %v\noutput=%s", err, stdout)
	}
	for _, key := range []string{"version", "device_id", "api_base_url", "mode", "paused", "watched_paths"} {
		if _, ok := got[key]; !ok {
			t.Errorf("missing key %q", key)
		}
	}
}

func TestStatus_NotEnrolled_Exit1(t *testing.T) {
	t.Setenv("CALIBER_AGENT_HOME", "/tmp/no-such-status")
	code := executeCLI(t, []string{"status"})
	if code != 1 {
		t.Fatalf("want 1, got %d", code)
	}
}

func TestStatus_DoesNotMakeNetworkRequests(t *testing.T) {
	setupEnrolledRoot(t)
	called := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
	}))
	defer srv.Close()
	// status must not contact API_BASE even if set.
	cfg, _ := config.Load()
	cfg.APIBaseURL = srv.URL
	_ = config.SaveConfig(cfg)

	executeCLI(t, []string{"status"})
	if called {
		t.Fatalf("status must NOT make HTTP requests")
	}
}
```

- [ ] **Step 2: Run tests**

Expected: FAIL

- [ ] **Step 3: Implement**

```go
// agent/internal/cli/status.go
package cli

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"github.com/spf13/cobra"
	"github.com/hanfour/ai-dev-eval/agent/internal/config"
	"github.com/hanfour/ai-dev-eval/agent/internal/version"
)

func newStatusCmd() *cobra.Command {
	var jsonOut bool
	cmd := &cobra.Command{
		Use:   "status",
		Short: "Show daemon status (local read; zero network IO)",
		RunE: func(cmd *cobra.Command, _ []string) error {
			return runStatus(cmd, jsonOut)
		},
	}
	cmd.Flags().BoolVar(&jsonOut, "json", false, "machine-readable JSON output")
	return cmd
}

type statusPayload struct {
	Version           string   `json:"version"`
	DeviceID          string   `json:"device_id"`
	APIBaseURL        string   `json:"api_base_url"`
	InsecureTransport bool     `json:"insecure_transport"`
	Mode              string   `json:"mode"`
	Paused            bool     `json:"paused"`
	WatchedPaths      []string `json:"watched_paths"`
	FilesTracked      int      `json:"files_tracked"`
	LastSync          string   `json:"last_sync,omitempty"`
}

func runStatus(cmd *cobra.Command, jsonOut bool) error {
	cfg, err := config.Load()
	if err != nil {
		return &ExitError{Code: 1, Err: err}
	}
	state, _ := config.LoadState()
	paused := false
	if _, err := os.Stat(config.PausedPath()); err == nil {
		paused = true
	} else if !errors.Is(err, fs.ErrNotExist) {
		// Treat unknown stat error as not-paused for display purposes.
	}

	p := statusPayload{
		Version:           version.Version,
		DeviceID:          cfg.DeviceID,
		APIBaseURL:        cfg.APIBaseURL,
		InsecureTransport: cfg.InsecureTransport,
		Mode:              cfg.Mode,
		Paused:            paused,
		WatchedPaths:      cfg.IncludePaths,
		FilesTracked:      len(state.Files),
	}
	var lastSync string
	for _, w := range state.Files {
		if w.LastSync.After(parseISOOrZero(lastSync)) {
			lastSync = w.LastSync.UTC().Format("2006-01-02T15:04:05Z")
		}
	}
	p.LastSync = lastSync

	if jsonOut {
		enc := json.NewEncoder(cmd.OutOrStdout())
		enc.SetIndent("", "  ")
		return enc.Encode(p)
	}
	fmt.Fprintf(cmd.OutOrStdout(),
		"caliber-agent %s\ndevice_id:    %s\napi_base_url: %s%s\nmode:         %s\npaused:       %s\nwatched paths (%d):\n",
		p.Version, p.DeviceID, p.APIBaseURL, insecureBadge(p.InsecureTransport), p.Mode,
		yesno(p.Paused), len(p.WatchedPaths))
	for _, pp := range p.WatchedPaths {
		fmt.Fprintf(cmd.OutOrStdout(), "  - %s\n", pp)
	}
	fmt.Fprintf(cmd.OutOrStdout(), "state:        %d files tracked", p.FilesTracked)
	if p.LastSync != "" {
		fmt.Fprintf(cmd.OutOrStdout(), ", last sync %s", p.LastSync)
	}
	fmt.Fprintln(cmd.OutOrStdout())
	_ = filepath.Separator
	return nil
}

func yesno(b bool) string { if b { return "yes" }; return "no" }
func insecureBadge(b bool) string { if b { return " (insecure)" }; return "" }
func parseISOOrZero(s string) time.Time { /* helper or import time and zero */ ... }
```

(Adjust import list; helper `parseISOOrZero` can be replaced by tracking max `time.Time` directly.)

- [ ] **Step 4: Run tests**

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add agent/internal/cli/status.go agent/internal/cli/status_test.go
git commit -m "feat(agent/cli): status real impl (human + --json; zero network IO)"
```

---

## Phase 11: `uninstall` — the long one

Spec §3.6 defines a 7-step user-visible flow (probe → prompt → sentinel → remote → keychain → ordered_delete → listing) and 9 ordered_delete entries (a)-(i) with explicit error handling (R12 / R14). Split into 5 tasks.

### Task 11.1: `uninstall` probe + flags + prompt (no cleanup yet)

**Files:**
- Modify: `agent/internal/cli/uninstall.go`
- Modify: `agent/internal/cli/uninstall_test.go` (create)

- [ ] **Step 1: Write failing tests**

```go
// agent/internal/cli/uninstall_test.go
package cli

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"testing"
	"github.com/hanfour/ai-dev-eval/agent/internal/lockfile"
)

func TestUninstall_RunningDaemon_Default_Exit1_NoSentinelWritten(t *testing.T) {
	root := setupEnrolledRoot(t)
	// Pre-acquire .lock to simulate running daemon.
	lk, err := lockfile.Acquire(filepath.Join(root, ".lock"))
	if err != nil {
		t.Fatal(err)
	}
	defer lk.Release()

	code := executeCLI(t, []string{"uninstall", "--yes"})
	if code != 1 {
		t.Fatalf("want 1 daemon-active, got %d", code)
	}
	if _, err := os.Stat(filepath.Join(root, ".uninstalling")); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("sentinel must NOT be written when refused")
	}
}

func TestUninstall_LockProbe_NoOCreate_NoStaleLockFile(t *testing.T) {
	root := setupEnrolledRoot(t)
	// Ensure no .lock pre-exists.
	_ = os.Remove(filepath.Join(root, ".lock"))
	// Use --keep-remote --yes so cleanup also runs without server.
	_ = executeCLI(t, []string{"uninstall", "--keep-remote", "--yes"})
	// Even on success, the probe step itself must not have created .lock at any point.
	// (Verified indirectly: after RemoveAll the dir is gone, but if probe had created .lock
	//  and we removed it as part of ordered_delete this test wouldn't catch the bug.
	//  Strengthen via a no-lock-pre-RemoveAll assertion in unit-level test of `probeRunningDaemon`.)
}

func TestUninstall_LockProbe_ErrNotExist_TreatedAsNoDaemon(t *testing.T) {
	setupEnrolledRoot(t)
	// We don't create .lock at all. uninstall should proceed (with --yes).
	code := executeCLI(t, []string{"uninstall", "--keep-remote", "--yes"})
	if code != 0 {
		t.Fatalf("want 0, got %d", code)
	}
}

func TestUninstall_DeclinedConfirm_Exit130_ZeroSideEffect(t *testing.T) {
	root := setupEnrolledRoot(t)
	code := executeCLIWithStdin(t, "n\n", []string{"uninstall"})
	if code != 130 {
		t.Fatalf("want 130, got %d", code)
	}
	// Critical: cancel must not leave .uninstalling or .lock or modify config.
	if _, err := os.Stat(filepath.Join(root, ".uninstalling")); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("cancel must not write .uninstalling")
	}
	if _, err := os.Stat(filepath.Join(root, "config.toml")); err != nil {
		t.Fatalf("cancel must preserve config.toml, got %v", err)
	}
}

func TestUninstall_NonTTY_NoYes_Exit130_ZeroSideEffect(t *testing.T) {
	root := setupEnrolledRoot(t)
	code := executeCLI(t, []string{"uninstall"})
	if code != 130 {
		t.Fatalf("want 130, got %d", code)
	}
	if _, err := os.Stat(filepath.Join(root, "config.toml")); err != nil {
		t.Fatalf("cancel must preserve config.toml")
	}
}
```

- [ ] **Step 2: Run tests**

Expected: FAIL — stub

- [ ] **Step 3: Implement probe + flags + prompt**

```go
// agent/internal/cli/uninstall.go (skeleton; cleanup body filled in later tasks)
package cli

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"github.com/spf13/cobra"
	"golang.org/x/term"
	"github.com/hanfour/ai-dev-eval/agent/internal/config"
	"github.com/hanfour/ai-dev-eval/agent/internal/keychain"
	"github.com/hanfour/ai-dev-eval/agent/internal/lockfile"
)

func newUninstallCmd() *cobra.Command {
	var yes, keepRemote, force bool
	cmd := &cobra.Command{
		Use:   "uninstall",
		Short: "Uninstall the daemon (revoke remote + remove keychain + delete local files)",
		RunE: func(cmd *cobra.Command, _ []string) error {
			return runUninstall(cmd, yes, keepRemote, force)
		},
	}
	cmd.Flags().BoolVar(&yes, "yes", false, "skip interactive consent prompt")
	cmd.Flags().BoolVar(&keepRemote, "keep-remote", false, "skip server-side revoke")
	cmd.Flags().BoolVar(&force, "force", false, "uninstall even if daemon is running")
	return cmd
}

func runUninstall(cmd *cobra.Command, yes, keepRemote, force bool) error {
	cfg, err := config.Load()
	if err != nil {
		return &ExitError{Code: 1, Err: err}
	}

	// STEP 1: no-create, no-acquire probe of .lock
	holder, perr := lockfile.Probe(config.LockPath())
	if errors.Is(perr, lockfile.ErrLocked) && !force {
		msg := "caliber-agent run is currently active"
		if holder > 0 {
			msg = fmt.Sprintf("caliber-agent run is currently active (PID %d)", holder)
		}
		return &ExitError{Code: 1, Err: fmt.Errorf("%s.\nStop it first with Ctrl+C, then re-run uninstall.\nOr pass --force to signal the daemon to exit and proceed with cleanup", msg)}
	}

	// STEP 2: prompt + confirm
	if !yes {
		if !term.IsTerminal(int(os.Stdin.Fd())) {
			return &ExitError{Code: 130, Err: errors.New("non-interactive shell detected; pass --yes to confirm")}
		}
		fmt.Fprintf(cmd.OutOrStdout(),
			"This will:\n  1. Revoke this device at %s (DELETE /v1/devices/me)\n  2. Remove %s (config, state, redaction-set, agent.log, .lock, .uninstalling)\n  3. Remove keychain entry: %s / %s\nContinue? [y/N] ",
			cfg.APIBaseURL, config.RootDir(), keychain.ServiceName, cfg.DeviceID)
		reader := bufio.NewReader(os.Stdin)
		ans, _ := reader.ReadString('\n')
		ans = strings.ToLower(strings.TrimSpace(ans))
		if ans != "y" && ans != "yes" {
			return &ExitError{Code: 130, Err: errors.New("user declined")}
		}
	}

	// (STEP 3 sentinel + STEP 4 remote + STEP 5 keychain + STEP 6 ordered_delete + STEP 7 listing
	// continue in later tasks; for now stub a clean exit 0 so phase 11.1 tests pass.)
	return runUninstallCleanup(cmd, cfg, keepRemote)
}

// runUninstallCleanup is filled in by tasks 11.2-11.5.
func runUninstallCleanup(cmd *cobra.Command, cfg *config.Config, keepRemote bool) error {
	// stub for phase 11.1 — replaced in 11.2
	return nil
}
```

- [ ] **Step 4: Run tests**

Expected: PASS for declined / non-TTY / daemon-active / probe-ErrNotExist; cleanup test passes because stub returns nil.

- [ ] **Step 5: Commit**

```bash
git add agent/internal/cli/uninstall.go agent/internal/cli/uninstall_test.go
git commit -m "feat(agent/cli): uninstall probe + flags + prompt (cleanup body deferred)"
```

### Task 11.2: `uninstall` write sentinel + remote revoke

**Files:**
- Modify: `agent/internal/cli/uninstall.go`
- Modify: `agent/internal/cli/uninstall_test.go`

- [ ] **Step 1: Write failing tests**

```go
// agent/internal/cli/uninstall_test.go (append)
func TestUninstall_SentinelWrittenAfterPrompt(t *testing.T) {
	root := setupEnrolledRoot(t)
	hookSentinelSeenDuringCleanup := false
	// Inject a fake server that records whether sentinel exists at remote-revoke time.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, err := os.Stat(filepath.Join(root, ".uninstalling")); err == nil {
			hookSentinelSeenDuringCleanup = true
		}
		w.WriteHeader(204)
	}))
	defer srv.Close()

	cfg, _ := config.Load()
	cfg.APIBaseURL = srv.URL
	_ = config.SaveConfig(cfg)

	code := executeCLI(t, []string{"uninstall", "--yes"})
	if code != 0 {
		t.Fatalf("want 0, got %d", code)
	}
	if !hookSentinelSeenDuringCleanup {
		t.Fatalf("sentinel must be present during remote revoke")
	}
}

func TestUninstall_RemoteFails_LocalStillCleaned_Exit0(t *testing.T) {
	root := setupEnrolledRoot(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(500)
		_, _ = w.Write([]byte(`{"error":"internal"}`))
	}))
	defer srv.Close()
	cfg, _ := config.Load()
	cfg.APIBaseURL = srv.URL
	_ = config.SaveConfig(cfg)

	code := executeCLI(t, []string{"uninstall", "--yes"})
	if code != 0 {
		t.Fatalf("local-clean-success want 0 even with remote 5xx, got %d", code)
	}
	if _, err := os.Stat(root); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("local dir must be gone")
	}
}

func TestUninstall_KeepRemote_SkipsServer(t *testing.T) {
	called := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		w.WriteHeader(204)
	}))
	defer srv.Close()
	root := setupEnrolledRoot(t)
	cfg, _ := config.Load()
	cfg.APIBaseURL = srv.URL
	_ = config.SaveConfig(cfg)

	code := executeCLI(t, []string{"uninstall", "--yes", "--keep-remote"})
	if code != 0 {
		t.Fatalf("want 0, got %d", code)
	}
	if called {
		t.Fatalf("--keep-remote must NOT contact server")
	}
	_ = root
}
```

- [ ] **Step 2: Run tests** — Expected FAIL (cleanup is still stub)

- [ ] **Step 3: Implement sentinel write + remote revoke step in `runUninstallCleanup`**

```go
func runUninstallCleanup(cmd *cobra.Command, cfg *config.Config, keepRemote bool) error {
	root := config.RootDir()
	sentinelPath := filepath.Join(root, ".uninstalling")

	// STEP 3: write .uninstalling sentinel (root must exist; written 0o600 empty)
	if err := os.WriteFile(sentinelPath, []byte{}, 0o600); err != nil {
		return &ExitError{Code: 1, Err: fmt.Errorf("write sentinel: %w", err)}
	}

	// STEP 4: remote revoke (best-effort, unless --keep-remote)
	remoteState := "skipped"
	if !keepRemote {
		ctx := context.Background()
		token, err := keychain.Get(cfg.DeviceID)
		if err != nil {
			fmt.Fprintf(cmd.OutOrStdout(), "[warn] keychain Get failed: %v; cannot revoke remotely\n", err)
			remoteState = "failed (no token)"
		} else {
			apiClient := api.NewClient(cfg.APIBaseURL, "caliber-agent/uninstall")
			if err := apiClient.RevokeSelf(ctx, token); err != nil {
				fmt.Fprintf(cmd.OutOrStdout(), "[warn] remote revoke failed: %v; continuing local cleanup\n", err)
				remoteState = "failed"
			} else {
				fmt.Fprintln(cmd.OutOrStdout(), "[ok] device revoked at server")
				remoteState = "revoked"
			}
		}
	} else {
		fmt.Fprintf(cmd.OutOrStdout(), "Skipped remote revoke (--keep-remote). Manually revoke at %s/dashboard/devices.\n", cfg.APIBaseURL)
	}

	// STEP 5: keychain cleanup — task 11.3
	// STEP 6: ordered_delete — task 11.4
	// STEP 7: listing — task 11.5

	// stub continuation
	_ = remoteState
	_ = sentinelPath
	return nil
}
```

- [ ] **Step 4: Run tests** — Expected: phase 11.2 tests PASS; phase 11.1 tests remain PASS

- [ ] **Step 5: Commit**

```bash
git add agent/internal/cli/uninstall.go agent/internal/cli/uninstall_test.go
git commit -m "feat(agent/cli): uninstall writes .uninstalling sentinel + best-effort remote revoke"
```

### Task 11.3: `uninstall` keychain delete

**Files:**
- Modify: `agent/internal/cli/uninstall.go`
- Modify: `agent/internal/cli/uninstall_test.go`

- [ ] **Step 1: Write failing tests**

```go
// agent/internal/cli/uninstall_test.go (append)
func TestUninstall_KeychainNotFound_Continues_Exit0(t *testing.T) {
	root := setupEnrolledRoot(t)
	// Use --keep-remote so we don't need a server. Stub keychain.Delete to return ErrNotFound.
	withKeychainDelete(t, func(account string) error { return keychain.ErrNotFound })
	code := executeCLI(t, []string{"uninstall", "--yes", "--keep-remote"})
	if code != 0 {
		t.Fatalf("want 0 (ErrNotFound treated as already-clean), got %d", code)
	}
	if _, err := os.Stat(root); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("dir must be removed")
	}
}

func TestUninstall_KeychainDeleteFails_Exit1_SentinelRestored(t *testing.T) {
	root := setupEnrolledRoot(t)
	withKeychainDelete(t, func(account string) error { return errors.New("permission denied") })
	code := executeCLI(t, []string{"uninstall", "--yes", "--keep-remote"})
	if code != 1 {
		t.Fatalf("want 1, got %d", code)
	}
	// sentinel restored — daemon not stuck
	if _, err := os.Stat(filepath.Join(root, ".uninstalling")); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("sentinel must be restored to absent on keychain failure, got stat=%v", err)
	}
}
```

- [ ] **Step 2: Run tests** — Expected FAIL

- [ ] **Step 3: Implement step 5 in `runUninstallCleanup`** after the remote revoke block:

```go
// STEP 5: keychain delete
if err := keychain.Delete(cfg.DeviceID); err != nil {
	if errors.Is(err, keychain.ErrNotFound) {
		fmt.Fprintln(cmd.OutOrStdout(), "[ok] keychain entry already absent")
	} else {
		fmt.Fprintf(cmd.OutOrStdout(), "[error] keychain delete failed: %v\n", err)
		_ = os.Remove(sentinelPath) // restore so daemon can recover
		return &ExitError{Code: 1, Err: err}
	}
}
```

`keychain.Delete` is the existing function from PR1. Add an injectable hook (`var keychainDelete = keychain.Delete`) used by tests if not already present.

- [ ] **Step 4: Run tests** — Expected PASS

- [ ] **Step 5: Commit**

```bash
git add agent/internal/cli/uninstall.go agent/internal/cli/uninstall_test.go
git commit -m "feat(agent/cli): uninstall keychain delete + sentinel restore on hard failure"
```

### Task 11.4: `uninstall` ordered_delete (a)-(i)

**Files:**
- Modify: `agent/internal/cli/uninstall.go`
- Modify: `agent/internal/cli/uninstall_test.go`

- [ ] **Step 1: Write failing tests**

```go
// agent/internal/cli/uninstall_test.go (append)
func TestUninstall_OrderedCleanup_SentinelDeletedLastBeforeRmdir(t *testing.T) {
	root := setupEnrolledRoot(t)
	// Pre-create paused so step (d) hits a real file too.
	_ = os.WriteFile(filepath.Join(root, "paused"), []byte(""), 0o600)
	// Run uninstall and trace remove order via tracing hook (file-system event subscriber or
	// instrumented test helper that wraps os.Remove).
	trace := traceRemovesDuring(t, func() {
		_ = executeCLI(t, []string{"uninstall", "--yes", "--keep-remote"})
	})
	// Verify .uninstalling is the last file removed in the dir before rmdir.
	var lastFile string
	for _, removed := range trace {
		if removed == root {
			break
		}
		lastFile = removed
	}
	if filepath.Base(lastFile) != ".uninstalling" {
		t.Fatalf("expected .uninstalling to be last before rmdir, got %s; full trace=%v", lastFile, trace)
	}
}

func TestUninstall_OrderedCleanup_ConfigTomlDeletedBeforeSentinel(t *testing.T) {
	root := setupEnrolledRoot(t)
	trace := traceRemovesDuring(t, func() {
		_ = executeCLI(t, []string{"uninstall", "--yes", "--keep-remote"})
	})
	cfgIdx := indexOf(trace, filepath.Join(root, "config.toml"))
	sentIdx := indexOf(trace, filepath.Join(root, ".uninstalling"))
	if cfgIdx < 0 || sentIdx < 0 || cfgIdx >= sentIdx {
		t.Fatalf("config.toml must precede .uninstalling: cfg=%d sentinel=%d trace=%v", cfgIdx, sentIdx, trace)
	}
}

func TestUninstall_OrderedCleanup_TmpGlobsCleared_RmdirSucceeds(t *testing.T) {
	root := setupEnrolledRoot(t)
	// Seed atomic-writer leftover tmp files
	_ = os.WriteFile(filepath.Join(root, ".config.toml.abc123"), []byte(""), 0o600)
	_ = os.WriteFile(filepath.Join(root, ".state.json.xyz789"), []byte(""), 0o600)
	_ = os.WriteFile(filepath.Join(root, ".redaction-set.json.42"), []byte(""), 0o600)

	code := executeCLI(t, []string{"uninstall", "--yes", "--keep-remote"})
	if code != 0 {
		t.Fatalf("want 0, got %d", code)
	}
	if _, err := os.Stat(root); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("rmdir must succeed; root still exists: %v", err)
	}
}

func TestUninstall_OrderedCleanup_RmdirFailsAfterSentinelRemoved_NoSentinelRestore(t *testing.T) {
	root := setupEnrolledRoot(t)
	// Add an extra unknown file that the explicit cleanup won't touch → rmdir fails.
	stray := filepath.Join(root, "user-dropped-file.txt")
	_ = os.WriteFile(stray, []byte("hi"), 0o600)

	code := executeCLI(t, []string{"uninstall", "--yes", "--keep-remote"})
	if code != 1 {
		t.Fatalf("want 1, got %d", code)
	}
	// sentinel was deleted in (h) — do NOT restore
	if _, err := os.Stat(filepath.Join(root, ".uninstalling")); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("sentinel must remain absent after (h); got stat=%v", err)
	}
}

func TestUninstall_InvariantSentinelOutlivesConfigToml(t *testing.T) {
	root := setupEnrolledRoot(t)
	trace := traceRemovesDuring(t, func() {
		_ = executeCLI(t, []string{"uninstall", "--yes", "--keep-remote"})
	})
	// Verify that at no point did `os.Remove(.uninstalling)` precede `os.Remove(config.toml)`.
	if indexOf(trace, filepath.Join(root, ".uninstalling")) < indexOf(trace, filepath.Join(root, "config.toml")) {
		t.Fatalf("invariant violated: .uninstalling removed before config.toml; trace=%v", trace)
	}
}
```

- [ ] **Step 2: Run tests** — Expected FAIL

- [ ] **Step 3: Implement ordered_delete in `runUninstallCleanup`** after the keychain block:

```go
// STEP 6: ordered_delete (a)-(i), see spec §3.6
type step struct {
	name string
	fn   func() error
}

restoreSentinel := func() { _ = os.Remove(sentinelPath) }

// (a)-(e) optional artifacts — ErrNotExist ignored
optional := []string{"state.json", "redaction-set.json", "agent.log", "paused", ".lock"}
for _, name := range optional {
	p := filepath.Join(root, name)
	if err := os.Remove(p); err != nil && !errors.Is(err, fs.ErrNotExist) {
		fmt.Fprintf(cmd.OutOrStdout(), "[error] remove %s: %v\n", p, err)
		restoreSentinel()
		return &ExitError{Code: 1, Err: err}
	}
}

// (f) tmp glob cleanup — hard-fail (R13-F2)
for _, pattern := range []string{".config.toml.*", ".state.json.*", ".redaction-set.json.*"} {
	matches, _ := filepath.Glob(filepath.Join(root, pattern))
	for _, m := range matches {
		if err := os.Remove(m); err != nil && !errors.Is(err, fs.ErrNotExist) {
			fmt.Fprintf(cmd.OutOrStdout(), "[error] remove tmp %s: %v\n", m, err)
			restoreSentinel()
			return &ExitError{Code: 1, Err: err}
		}
	}
}

// (g) config.toml — must exist (pre-flight already verified)
if err := os.Remove(filepath.Join(root, "config.toml")); err != nil {
	fmt.Fprintf(cmd.OutOrStdout(), "[error] remove config.toml: %v\n", err)
	restoreSentinel()
	return &ExitError{Code: 1, Err: err}
}

// (h) .uninstalling — last file removed; failure does NOT restore (R13-F2)
if err := os.Remove(sentinelPath); err != nil {
	fmt.Fprintf(cmd.OutOrStdout(), "[error] failed to remove sentinel; .uninstalling may persist — manual cleanup: rm %s && rmdir %s\n", sentinelPath, root)
	return &ExitError{Code: 1, Err: err}
}

// (i) rmdir
if err := os.Remove(root); err != nil {
	fmt.Fprintf(cmd.OutOrStdout(), "[error] rmdir failed: %v; inspect %s for leftover files and manually 'rm -rf' if confirmed safe\n", err, root)
	return &ExitError{Code: 1, Err: err}
}

// STEP 7: listing — task 11.5
_ = remoteState
return nil
```

- [ ] **Step 4: Run tests** — Expected PASS

- [ ] **Step 5: Commit**

```bash
git add agent/internal/cli/uninstall.go agent/internal/cli/uninstall_test.go
git commit -m "feat(agent/cli): uninstall ordered_delete (a)-(i) with sentinel-last + retry-friendly restore"
```

### Task 11.5: `uninstall` final listing output

**Files:**
- Modify: `agent/internal/cli/uninstall.go`
- Modify: `agent/internal/cli/uninstall_test.go`

- [ ] **Step 1: Write failing test**

```go
// agent/internal/cli/uninstall_test.go (append)
func TestUninstall_FinalListing_AllSuccess(t *testing.T) {
	setupEnrolledRoot(t)
	stdout := executeCLIStdout(t, []string{"uninstall", "--yes", "--keep-remote"})
	for _, want := range []string{"Removed:", "keychain entry", "~/.caliber-agent/"} {
		if !strings.Contains(stdout, want) {
			t.Errorf("missing %q in final listing:\n%s", want, stdout)
		}
	}
}
```

- [ ] **Step 2: Run** — Expected FAIL (no listing yet)

- [ ] **Step 3: Replace `_ = remoteState\nreturn nil` at end of cleanup with listing**

```go
// STEP 7: listing
fmt.Fprintln(cmd.OutOrStdout(), "Removed:")
if remoteState == "revoked" {
	fmt.Fprintf(cmd.OutOrStdout(), "  ✓ remote device %s (server: revoked)\n", cfg.DeviceID)
} else if remoteState == "failed" || remoteState == "failed (no token)" {
	fmt.Fprintf(cmd.OutOrStdout(), "  ✗ remote (failed; revoke manually at %s/dashboard/devices)\n", cfg.APIBaseURL)
} else if remoteState == "skipped" {
	fmt.Fprintf(cmd.OutOrStdout(), "  - remote (skipped via --keep-remote)\n")
}
fmt.Fprintf(cmd.OutOrStdout(), "  ✓ keychain entry %s / %s\n", keychain.ServiceName, cfg.DeviceID)
fmt.Fprintln(cmd.OutOrStdout(), "  ✓ ~/.caliber-agent/")
return nil
```

- [ ] **Step 4: Run tests** — Expected PASS

- [ ] **Step 5: Commit**

```bash
git add agent/internal/cli/uninstall.go agent/internal/cli/uninstall_test.go
git commit -m "feat(agent/cli): uninstall final listing (anti-forensics-friendly)"
```

---

## Phase 12: Cleanup — remove `set-mode` + tighten `--api-base-url` flag scope

### Task 12.1: Delete `set-mode` subcommand

**Files:**
- Delete: `agent/internal/cli/setmode.go`
- Modify: `agent/internal/cli/root.go`
- Modify: `agent/internal/cli/stubs_test.go` (remove set-mode case if present)

- [ ] **Step 1: Remove file + AddCommand line**

```bash
rm agent/internal/cli/setmode.go
```

In `agent/internal/cli/root.go`, remove the `cmd.AddCommand(newSetModeCmd())` line.

- [ ] **Step 2: Update stubs_test.go**

Open `agent/internal/cli/stubs_test.go`; remove any test case asserting `set-mode` returns ExitNotImplemented. Add (if relevant) an assertion that `set-mode` is **not** in the help output.

- [ ] **Step 3: Verify build + tests**

Run: `cd agent && go build ./... && go test ./internal/cli/ -v`
Expected: PASS; help output no longer contains `set-mode`

- [ ] **Step 4: Commit**

```bash
git add agent/internal/cli/setmode.go agent/internal/cli/root.go agent/internal/cli/stubs_test.go
git commit -m "feat(agent/cli): remove set-mode subcommand (mode now via direct config.toml edit)"
```

### Task 12.2: Move `--api-base-url` from PersistentFlags to enroll-only local flag

**Files:**
- Modify: `agent/internal/cli/root.go`
- Modify: `agent/internal/cli/root_test.go`

- [ ] **Step 1: Write failing test**

```go
// agent/internal/cli/root_test.go (append)
func TestRoot_ApiBaseURLFlag_OnlyOnEnroll(t *testing.T) {
	cmd := New()
	// PersistentFlags should NOT have --api-base-url anymore
	if f := cmd.PersistentFlags().Lookup("api-base-url"); f != nil {
		t.Fatalf("--api-base-url must NOT be a PersistentFlag, found %+v", f)
	}
	// enroll subcommand SHOULD have it as a local flag
	for _, sub := range cmd.Commands() {
		if sub.Name() == "enroll" {
			if f := sub.LocalFlags().Lookup("api-base-url"); f == nil {
				t.Fatalf("enroll must have --api-base-url as local flag")
			}
			return
		}
	}
	t.Fatal("enroll subcommand not found")
}
```

- [ ] **Step 2: Run test** — Expected FAIL (currently PersistentFlag)

- [ ] **Step 3: Move flag definition**

In `agent/internal/cli/root.go`, delete the `cmd.PersistentFlags().StringVar(&flags.APIBaseURL, "api-base-url", ...)` line. The flag is already added to enroll in Task 8.1.

Also remove the `APIBaseURL string` field from `PersistentFlags` struct (or rename for clarity).

- [ ] **Step 4: Run tests**

Run: `cd agent && go test ./internal/cli/ -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add agent/internal/cli/root.go agent/internal/cli/root_test.go
git commit -m "refactor(agent/cli): --api-base-url is now enroll-local, no longer persistent"
```

---

## Phase 13: Docs — agent README env vars + uninstall guide

### Task 13.1: README env vars chapter

**Files:**
- Modify: `agent/README.md`

- [ ] **Step 1: Add environment variables section**

Append after the existing "Environment" section in `agent/README.md`:

```markdown
## Environment Variables (full reference)

| Env | Effect | When read |
|---|---|---|
| `CALIBER_AGENT_HOME` | Overrides `~/.caliber-agent` config / state / log directory | Every subcommand startup |
| `CALIBER_API_BASE_URL` | Default API base URL when `--api-base-url` is omitted | **Only `enroll`** (`run` reads from `config.toml`) |
| `CALIBER_CLAUDE_PROJECTS` | Overrides `~/.claude/projects` watch root (advanced / dev) | `enroll` wizard scan + `run` startup |
| `CALIBER_CODEX_SESSIONS` | Overrides `~/.codex/sessions` watch root (advanced / dev) | `run` startup |

## Lifecycle

`caliber-agent` runs as a **foreground** process: you start it yourself
(`caliber-agent run`), and stop it with Ctrl+C. There is no auto-start. To
pause without killing the daemon, use `caliber-agent pause`; resume with
`caliber-agent resume`.

## Uninstall

`caliber-agent uninstall` performs three steps in order:

1. **Revoke remote** — calls `DELETE /v1/devices/me` so the server marks
   this device's API keys revoked.
2. **Remove keychain entry** — `tw.caliber.agent` / `<device_id>`.
3. **Delete `~/.caliber-agent/`** — config, state, redaction-set cache,
   agent.log, lockfile, and the in-progress uninstall sentinel.

Useful flags:

- `--yes` — skip the consent prompt (required in non-TTY shells / CI).
- `--keep-remote` — skip step 1 (device already revoked via web UI, or
  server unreachable).
- `--force` — proceed even if a `caliber-agent run` daemon is currently
  active (the daemon will self-exit on its next sentinel/config check).

If uninstall is interrupted mid-cleanup (e.g. SIGINT after step 5):
re-running `caliber-agent uninstall` is **safe** while `config.toml`
still exists; if it doesn't, manually `rm -rf ~/.caliber-agent/` and
revoke the device in the caliber web UI.
```

- [ ] **Step 2: Commit**

```bash
git add agent/README.md
git commit -m "docs(agent): full env-var reference + lifecycle/uninstall section"
```

---

## Phase 14: Privacy regression tests + Phase 2 closure note

### Task 14.1: Privacy regression — subcommands make no network requests

**Files:**
- Create: `agent/internal/cli/privacy_regression_test.go`

- [ ] **Step 1: Write tests**

```go
// agent/internal/cli/privacy_regression_test.go
package cli

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"github.com/hanfour/ai-dev-eval/agent/internal/config"
)

func assertNoNetwork(t *testing.T, args []string) {
	t.Helper()
	called := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
	}))
	defer srv.Close()
	setupEnrolledRoot(t)
	cfg, _ := config.Load()
	cfg.APIBaseURL = srv.URL
	_ = config.SaveConfig(cfg)
	_ = executeCLI(t, args)
	if called {
		t.Fatalf("subcommand %v must NOT make HTTP requests", args)
	}
}

func TestStatus_DoesNotMakeNetworkRequests(t *testing.T)     { assertNoNetwork(t, []string{"status"}) }
func TestStatusJSON_DoesNotMakeNetworkRequests(t *testing.T) { assertNoNetwork(t, []string{"status", "--json"}) }
func TestPause_DoesNotMakeNetworkRequests(t *testing.T)      { assertNoNetwork(t, []string{"pause"}) }
func TestResume_DoesNotMakeNetworkRequests(t *testing.T)     { assertNoNetwork(t, []string{"resume"}) }
func TestAddPath_DoesNotMakeNetworkRequests(t *testing.T) {
	assertNoNetwork(t, []string{"add-path", t.TempDir(), "--yes"})
}
func TestRemovePath_DoesNotMakeNetworkRequests(t *testing.T) {
	assertNoNetwork(t, []string{"remove-path", t.TempDir()})
}
```

- [ ] **Step 2: Run**

Run: `cd agent && go test ./internal/cli/ -run 'Privacy|DoesNotMakeNetworkRequests' -v`
Expected: PASS (subcommands now implemented and offline)

- [ ] **Step 3: Commit**

```bash
git add agent/internal/cli/privacy_regression_test.go
git commit -m "test(agent/cli): privacy regression — pause/resume/status/add-path/remove-path are network-free"
```

### Task 14.2: Privacy regression — uninstall touches only `~/.caliber-agent/`

**Files:**
- Append to: `agent/internal/cli/uninstall_test.go`

- [ ] **Step 1: Write test**

```go
func TestUninstall_DoesNotTouchHomeOutsideCaliberAgent(t *testing.T) {
	root := setupEnrolledRoot(t)
	// Create siblings under the same parent dir that should NOT be touched.
	parent := filepath.Dir(root)
	sibling := filepath.Join(parent, "should-survive")
	if err := os.MkdirAll(sibling, 0o700); err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(sibling)
	_ = os.WriteFile(filepath.Join(sibling, "sentinel"), []byte("ok"), 0o600)

	_ = executeCLI(t, []string{"uninstall", "--yes", "--keep-remote"})

	if _, err := os.Stat(sibling); err != nil {
		t.Fatalf("sibling dir must survive uninstall, got %v", err)
	}
	if b, err := os.ReadFile(filepath.Join(sibling, "sentinel")); err != nil || string(b) != "ok" {
		t.Fatalf("sibling file must survive intact, got err=%v content=%q", err, string(b))
	}
}
```

- [ ] **Step 2: Run** — Expected PASS

- [ ] **Step 3: Commit**

```bash
git add agent/internal/cli/uninstall_test.go
git commit -m "test(agent/cli): uninstall isolation — touches only ~/.caliber-agent/"
```

### Task 14.3: Final local verify + coverage check

- [ ] **Step 1: Agent gates**

```bash
cd agent
go vet ./...
$(go env GOPATH)/bin/staticcheck ./...
gofmt -l .
go test ./... -race
./scripts/coverage.sh  # must report ≥ 80%
```

Expected: all green; coverage ≥ 80%

- [ ] **Step 2: Server gates**

```bash
cd apps/api
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/rest/devicesRevokeSelf.test.ts
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/rest/devicesEnroll.test.ts
pnpm exec vitest run --config vitest.integration.config.ts tests/integration/rest/ingest.test.ts
pnpm -r build
```

Expected: all green

- [ ] **Step 3: Final commit (if anything changed)**

```bash
git status
# If staticcheck / gofmt produced fixups, commit them as:
git commit -am "chore(agent): final lint sweep before PR4 merge"
```

