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
