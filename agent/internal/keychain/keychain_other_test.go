//go:build !darwin

package keychain

import (
	"errors"
	"testing"
)

func TestNonDarwinReturnsErrUnsupported(t *testing.T) {
	if err := Set("a", "b"); !errors.Is(err, ErrUnsupported) {
		t.Errorf("Set: %v", err)
	}
	if _, err := Get("a"); !errors.Is(err, ErrUnsupported) {
		t.Errorf("Get: %v", err)
	}
	if err := Delete("a"); !errors.Is(err, ErrUnsupported) {
		t.Errorf("Delete: %v", err)
	}
}
