//go:build !darwin

package lockfile

import "errors"

// ErrUnsupported indicates lockfile is not implemented on this platform.
var ErrUnsupported = errors.New("lockfile: not supported on this platform")

// ErrLocked is provided for cross-platform symmetry with the darwin build.
var ErrLocked = errors.New("lockfile: already held")

// Lock is a placeholder so callers can compile on non-darwin platforms.
type Lock struct{}

// Release is a no-op on non-darwin builds.
func (l *Lock) Release() {}

// Acquire is not supported on non-darwin builds; always returns ErrUnsupported.
func Acquire(path string) (*Lock, error) { return nil, ErrUnsupported }

// Probe is not supported on non-darwin builds; always returns ErrUnsupported.
func Probe(path string) (int, error) { return 0, ErrUnsupported }
