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

// MaxPatternCount caps the number of Patterns the daemon will accept in
// a single RedactionSet. Server-provided sets above this count are
// rejected outright (no pattern is compiled) — callers MUST fall back to
// stale cache or DefaultSet, NOT use the over-large set with all Regex
// fields nil (which would let secrets pass through unredacted).
const MaxPatternCount = 100

// ErrTooManyPatterns is the hard-fail sentinel returned by Compile when
// len(Patterns) > MaxPatternCount. Callers (BootstrapRedactionSet and
// the refresher goroutine) MUST detect this with errors.Is and fall back
// to a known-good set instead of installing the rejected one.
var ErrTooManyPatterns = errors.New("redact: pattern count exceeded MaxPatternCount")

// IsExpired returns true when now > FetchedAt + TTLSeconds.
func (r *RedactionSet) IsExpired(now time.Time) bool {
	expiry := r.FetchedAt.Add(time.Duration(r.TTLSeconds) * time.Second)
	return now.After(expiry)
}

// Compile rebuilds every pattern's *regexp.Regexp from its RegexSrc.
//
// Two failure modes:
//
//  1. Count overflow — len(Patterns) > MaxPatternCount returns
//     ErrTooManyPatterns immediately, BEFORE compiling any pattern. The
//     entire set is rejected; callers must fall back.
//  2. Per-pattern failure — bad regex (or oversized RegexSrc) on an
//     individual pattern is fault-tolerant: aggregate error names the
//     bad patterns but good patterns are still compiled and usable.
func (r *RedactionSet) Compile() error {
	if len(r.Patterns) > MaxPatternCount {
		return fmt.Errorf("%w: got %d limit %d", ErrTooManyPatterns, len(r.Patterns), MaxPatternCount)
	}
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
