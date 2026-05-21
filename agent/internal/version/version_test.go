package version

import (
	"strings"
	"testing"
)

func TestStringWithDefaults(t *testing.T) {
	// Defaults represent a developer's `go run` build with no ldflags.
	if got := String(); got != "dev (unknown, unknown)" {
		t.Fatalf("String() with defaults = %q, want %q", got, "dev (unknown, unknown)")
	}
}

func TestStringWithOverrides(t *testing.T) {
	defer func(v, c, b string) { Version, Commit, BuiltAt = v, c, b }(Version, Commit, BuiltAt)
	Version = "0.1.0"
	Commit = "abc1234"
	BuiltAt = "2026-05-21T10:00:00Z"
	got := String()
	if !strings.Contains(got, "0.1.0") || !strings.Contains(got, "abc1234") || !strings.Contains(got, "2026-05-21T10:00:00Z") {
		t.Fatalf("String() with overrides = %q, missing one of the fields", got)
	}
}
