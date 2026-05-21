package cli

import (
	"context"
	"errors"
	"fmt"
)

// ExitError carries a non-zero process exit code through Cobra's error chain.
// Sub-commands return *ExitError when they need a specific code; the top-level
// Execute func unwraps it. Codes are documented in spec §8.
type ExitError struct {
	Code int
	Err  error
}

func (e *ExitError) Error() string { return e.Err.Error() }
func (e *ExitError) Unwrap() error { return e.Err }

// ExitFromErr maps a domain error into an *ExitError. Already-*ExitError
// values pass through unchanged. context.Canceled becomes exit 130 (SIGINT).
// All other errors become exit 1.
func ExitFromErr(err error) *ExitError {
	if err == nil {
		return nil
	}
	var ee *ExitError
	if errors.As(err, &ee) {
		return ee
	}
	if errors.Is(err, context.Canceled) {
		return &ExitError{Code: 130, Err: err}
	}
	return &ExitError{Code: 1, Err: err}
}

// ExitNotImplemented is returned by command stubs that exist for CLI surface
// stability but have no body yet (spec §4.6).
func ExitNotImplemented(cmd string) error {
	return &ExitError{
		Code: 64,
		Err:  fmt.Errorf("caliber-agent %s: not yet implemented in this release; see https://github.com/hanfour/caliber for the daemon roadmap", cmd),
	}
}
