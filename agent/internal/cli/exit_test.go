package cli

import (
	"context"
	"errors"
	"testing"

	"github.com/charmbracelet/huh"
)

func TestExitErrorImplementsErrorAndUnwrap(t *testing.T) {
	inner := errors.New("boom")
	ee := &ExitError{Code: 7, Err: inner}
	if ee.Error() != "boom" {
		t.Fatalf("Error() = %q, want %q", ee.Error(), "boom")
	}
	if !errors.Is(ee, inner) {
		t.Fatal("errors.Is(ee, inner) = false, want true (Unwrap)")
	}
}

func TestExitNotImplementedReturns64(t *testing.T) {
	err := ExitNotImplemented("status")
	var ee *ExitError
	if !errors.As(err, &ee) {
		t.Fatal("ExitNotImplemented should return *ExitError")
	}
	if ee.Code != 64 {
		t.Fatalf("Code = %d, want 64", ee.Code)
	}
}

func TestExitFromErrPassesThroughExitError(t *testing.T) {
	original := &ExitError{Code: 130, Err: errors.New("cancelled")}
	out := ExitFromErr(original)
	if out != original {
		t.Fatal("ExitFromErr should pass *ExitError through unchanged")
	}
}

func TestExitFromErrDefaultsTo1(t *testing.T) {
	out := ExitFromErr(errors.New("any random error"))
	if out.Code != 1 {
		t.Fatalf("Code = %d, want 1", out.Code)
	}
}

func TestExitFromErrHandlesHuhUserAborted(t *testing.T) {
	out := ExitFromErr(huh.ErrUserAborted)
	if out.Code != 130 {
		t.Fatalf("Code = %d, want 130", out.Code)
	}
}

func TestExitFromErrHandlesContextCanceled(t *testing.T) {
	out := ExitFromErr(context.Canceled)
	if out.Code != 130 {
		t.Fatalf("Code = %d, want 130", out.Code)
	}
}
