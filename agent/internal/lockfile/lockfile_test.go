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
