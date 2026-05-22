// Package version exposes build metadata. Production builds override the
// vars via -ldflags; `go run` / unset builds keep the defaults so the
// daemon is still functional and identifiable as a dev build.
package version

import "fmt"

var (
	Version = "dev"
	Commit  = "unknown"
	BuiltAt = "unknown"
)

// String returns a single-line human-readable build identifier.
func String() string {
	return fmt.Sprintf("%s (%s, %s)", Version, Commit, BuiltAt)
}
