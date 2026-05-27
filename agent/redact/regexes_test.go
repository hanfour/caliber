package redact

import (
	"strings"
	"testing"
)

func TestDefaultPatterns_AllCompile(t *testing.T) {
	for i := range DefaultPatterns {
		p := &DefaultPatterns[i]
		if err := p.Compile(); err != nil {
			t.Errorf("pattern %q failed to compile: %v", p.Name, err)
		}
	}
}

func TestScrubString_AnthropicKeyMasked(t *testing.T) {
	mustCompileAll(t, DefaultPatterns)
	got := ScrubString("token: sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123", DefaultPatterns)
	if !strings.Contains(got, "sk-ant-***") {
		t.Errorf("got %q", got)
	}
}

func TestScrubString_AwsAccessKeyMasked(t *testing.T) {
	mustCompileAll(t, DefaultPatterns)
	got := ScrubString("key=AKIAIOSFODNN7EXAMPLE more text", DefaultPatterns)
	if !strings.Contains(got, "AKIA***") {
		t.Errorf("got %q", got)
	}
	if strings.Contains(got, "AKIAIOSFODNN7EXAMPLE") {
		t.Errorf("raw key leaked: %q", got)
	}
}

func TestScrubString_BearerMasked(t *testing.T) {
	mustCompileAll(t, DefaultPatterns)
	got := ScrubString("Authorization: Bearer abc123def456ghi789jkl012mnop345", DefaultPatterns)
	if !strings.Contains(got, "Bearer ***") {
		t.Errorf("got %q", got)
	}
}

func TestScrubString_NearMissDoesNotMatch(t *testing.T) {
	// "sk-" with only 5 chars after — below the {20,} threshold.
	mustCompileAll(t, DefaultPatterns)
	got := ScrubString("partial: sk-short", DefaultPatterns)
	if got != "partial: sk-short" {
		t.Errorf("near-miss got scrubbed: %q", got)
	}
}

func TestScrubString_EmptyPatternsIsIdentity(t *testing.T) {
	got := ScrubString("anything sk-with-lots-of-chars-here", nil)
	if got != "anything sk-with-lots-of-chars-here" {
		t.Errorf("got %q", got)
	}
}

func TestScrubString_IsIdempotent(t *testing.T) {
	mustCompileAll(t, DefaultPatterns)
	once := ScrubString("Bearer abc123def456ghi789jkl012mnop345", DefaultPatterns)
	twice := ScrubString(once, DefaultPatterns)
	if once != twice {
		t.Errorf("not idempotent:\n once: %q\ntwice: %q", once, twice)
	}
}

func mustCompileAll(t *testing.T, ps []Pattern) {
	t.Helper()
	for i := range ps {
		if err := ps[i].Compile(); err != nil {
			t.Fatalf("compile %q: %v", ps[i].Name, err)
		}
	}
}

func TestPatternCompile_RejectsOversized_KeepsOthers(t *testing.T) {
	big := strings.Repeat("a", MaxRegexSrcLen+1)
	pats := []Pattern{
		{Name: "ok", RegexSrc: `sk-[a-z]+`, Replacement: "***"},
		{Name: "huge", RegexSrc: big, Replacement: "***"},
	}
	rs := &RedactionSet{Patterns: pats}
	err := rs.Compile()
	if err == nil {
		t.Fatalf("oversized pattern should aggregate error")
	}
	if rs.Patterns[0].Regex == nil {
		t.Fatalf("good pattern must still compile")
	}
	if rs.Patterns[1].Regex != nil {
		t.Fatalf("oversized pattern must NOT compile")
	}
}
