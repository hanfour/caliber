package redact

import (
	"errors"
	"fmt"
	"strings"
	"time"
)

// RedactionSet is the per-org effective secret-scrub set the daemon
// applies. The disk-cached form serialises via JSON (RegexSrc + Name +
// Replacement); Regex is rebuilt via Compile() after load / fetch.
type RedactionSet struct {
	Patterns   []Pattern `json:"patterns"`
	Version    string    `json:"version"`
	FetchedAt  time.Time `json:"fetched_at"`
	TTLSeconds int64     `json:"ttl_seconds"`
}

// IsExpired returns true when now > FetchedAt + TTLSeconds.
func (r *RedactionSet) IsExpired(now time.Time) bool {
	expiry := r.FetchedAt.Add(time.Duration(r.TTLSeconds) * time.Second)
	return now.After(expiry)
}

// Compile rebuilds every pattern's *regexp.Regexp from its RegexSrc.
// Per-pattern fault-tolerant: a bad regex doesn't break the set; just
// returns an aggregate error listing the bad names. Callers should
// log the error and continue using the compiled subset.
func (r *RedactionSet) Compile() error {
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

// DefaultSet returns a fresh RedactionSet built from the bundled
// DefaultPatterns. Used as the bottom fallback when fetch fails and no
// cached set exists.
func DefaultSet() *RedactionSet {
	patterns := make([]Pattern, len(DefaultPatterns))
	copy(patterns, DefaultPatterns)
	s := &RedactionSet{
		Patterns:   patterns,
		Version:    "bundled-default",
		FetchedAt:  time.Now().UTC(),
		TTLSeconds: 86400,
	}
	_ = s.Compile()
	return s
}

// ErrNoRedactionSet is returned by config.LoadRedactionSet when no
// cached set exists on disk yet. Not a real error — caller falls
// through to fetch / default.
var ErrNoRedactionSet = errors.New("redact: no cached set")
