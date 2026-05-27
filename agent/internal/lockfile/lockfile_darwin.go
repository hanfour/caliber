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
//
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
