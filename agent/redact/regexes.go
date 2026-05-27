package redact

import (
	"fmt"
	"regexp"
)

// MaxRegexSrcLen is the maximum allowed byte length of an individual
// Pattern.RegexSrc. Patterns longer than this are rejected by Compile()
// to bound per-pattern memory / compile cost when fetching server-provided
// regex sets.
const MaxRegexSrcLen = 1024

// Pattern is one secret-scrub regex with a replacement template. RegexSrc
// holds the source string so the set can be serialised to JSON / fetched
// from the server; Regex is the compiled form, rebuilt via Compile().
type Pattern struct {
	Name        string         `json:"name"`
	Regex       *regexp.Regexp `json:"-"`
	RegexSrc    string         `json:"regex"`
	Replacement string         `json:"replacement"`
}

// Compile parses RegexSrc into Regex. Returns an error with the pattern
// name on bad regex or oversized RegexSrc. Callers should skip bad
// patterns + log; one broken pattern must not break the set.
func (p *Pattern) Compile() error {
	if p.Regex != nil {
		return nil
	}
	if len(p.RegexSrc) > MaxRegexSrcLen {
		return fmt.Errorf("pattern %q: regex too long (%d > %d)", p.Name, len(p.RegexSrc), MaxRegexSrcLen)
	}
	re, err := regexp.Compile(p.RegexSrc)
	if err != nil {
		return fmt.Errorf("pattern %q: %w", p.Name, err)
	}
	p.Regex = re
	return nil
}

// DefaultPatterns is the bundled secret-scrub set. Mirrors
// apps/api/src/rest/redactionSet.ts SERVER_DEFAULT_PATTERNS — a parity
// test in that file asserts the two stay in sync.
//
// Order matters: the most-specific patterns (sk-proj-, sk-ant-api) MUST
// appear BEFORE the generic sk- pattern so multi-pattern matches mask the
// more-informative form first.
var DefaultPatterns = []Pattern{
	{Name: "anthropic_console", RegexSrc: `sk-ant-api[0-9]{2}-[A-Za-z0-9_\-]{20,}`, Replacement: "sk-ant-***"},
	{Name: "openai_project", RegexSrc: `sk-proj-[A-Za-z0-9_\-]{20,}`, Replacement: "sk-proj-***"},
	{Name: "anthropic_or_openai_legacy", RegexSrc: `sk-[a-zA-Z0-9_\-]{20,}`, Replacement: "sk-***"},
	{Name: "aws_access_key", RegexSrc: `AKIA[0-9A-Z]{16}`, Replacement: "AKIA***"},
	{Name: "github_pat", RegexSrc: `ghp_[A-Za-z0-9]{36,}`, Replacement: "ghp_***"},
	{Name: "github_oauth", RegexSrc: `gho_[A-Za-z0-9]{36,}`, Replacement: "gho_***"},
	{Name: "github_pat_fine_grained", RegexSrc: `github_pat_[A-Za-z0-9_]{82}`, Replacement: "github_pat_***"},
	{Name: "slack_bot", RegexSrc: `xoxb-[A-Za-z0-9\-]{40,}`, Replacement: "xoxb-***"},
	{Name: "slack_user", RegexSrc: `xoxp-[A-Za-z0-9\-]{40,}`, Replacement: "xoxp-***"},
	{Name: "groq", RegexSrc: `gsk_[A-Za-z0-9]{20,}`, Replacement: "gsk_***"},
	{Name: "bearer_generic", RegexSrc: `Bearer\s+[A-Za-z0-9_\-.]{20,}`, Replacement: "Bearer ***"},
}

// ScrubString applies each Pattern's Regex.ReplaceAllString with its
// Replacement. Patterns with nil Regex (uncompiled) are skipped.
// Empty / nil patterns slice returns s unchanged.
func ScrubString(s string, patterns []Pattern) string {
	for i := range patterns {
		if patterns[i].Regex == nil {
			continue
		}
		s = patterns[i].Regex.ReplaceAllString(s, patterns[i].Replacement)
	}
	return s
}
