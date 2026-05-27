package redact

import (
	"encoding/json"
	"errors"
	"testing"
	"time"
)

func TestRedactionSet_IsExpired(t *testing.T) {
	r := &RedactionSet{
		FetchedAt:  time.Date(2026, 5, 22, 10, 0, 0, 0, time.UTC),
		TTLSeconds: 3600,
	}
	if r.IsExpired(time.Date(2026, 5, 22, 10, 30, 0, 0, time.UTC)) {
		t.Error("should NOT be expired at +30min")
	}
	if !r.IsExpired(time.Date(2026, 5, 22, 11, 30, 0, 0, time.UTC)) {
		t.Error("should be expired at +1h30m")
	}
}

func TestRedactionSet_CompileSkipsBadPatternsButKeepsGoodOnes(t *testing.T) {
	r := &RedactionSet{
		Patterns: []Pattern{
			{Name: "good", RegexSrc: `AKIA[0-9A-Z]{16}`, Replacement: "***"},
			{Name: "bad", RegexSrc: `[unclosed`, Replacement: "***"},
			{Name: "good2", RegexSrc: `sk-[a-z]+`, Replacement: "***"},
		},
	}
	err := r.Compile()
	if err == nil {
		t.Error("expected aggregated error for bad pattern")
	}
	if r.Patterns[0].Regex == nil {
		t.Error("good pattern 0 should compile")
	}
	if r.Patterns[1].Regex != nil {
		t.Error("bad pattern should NOT have Regex set")
	}
	if r.Patterns[2].Regex == nil {
		t.Error("good pattern 2 should still compile (per-pattern fault-tolerant)")
	}
}

func TestRedactionSet_JSONRoundTrip(t *testing.T) {
	original := &RedactionSet{
		Patterns: []Pattern{
			{Name: "n", RegexSrc: `[0-9]+`, Replacement: "#"},
		},
		Version:    "v-test",
		FetchedAt:  time.Date(2026, 5, 23, 0, 0, 0, 0, time.UTC),
		TTLSeconds: 86400,
	}
	bs, _ := json.Marshal(original)
	var got RedactionSet
	if err := json.Unmarshal(bs, &got); err != nil {
		t.Fatal(err)
	}
	if got.Version != "v-test" || got.TTLSeconds != 86400 {
		t.Errorf("got %+v", got)
	}
	if len(got.Patterns) != 1 || got.Patterns[0].RegexSrc != `[0-9]+` {
		t.Errorf("Patterns lost: %+v", got.Patterns)
	}
	if got.Patterns[0].Regex != nil {
		t.Errorf("Regex should not deserialise; caller calls Compile()")
	}
}

func TestRedactionSetCompile_RejectsTooManyPatterns_ErrSentinel(t *testing.T) {
	pats := make([]Pattern, MaxPatternCount+1)
	for i := range pats {
		pats[i] = Pattern{Name: "p", RegexSrc: `a`, Replacement: "*"}
	}
	rs := &RedactionSet{Patterns: pats}
	err := rs.Compile()
	if !errors.Is(err, ErrTooManyPatterns) {
		t.Fatalf("want ErrTooManyPatterns, got %v", err)
	}
	for i := range pats {
		if rs.Patterns[i].Regex != nil {
			t.Fatalf("on ErrTooManyPatterns, no pattern must be compiled (i=%d)", i)
		}
	}
}

func TestRedactionSetCompile_AtBoundary(t *testing.T) {
	pats := make([]Pattern, MaxPatternCount)
	for i := range pats {
		pats[i] = Pattern{Name: "p", RegexSrc: `a`, Replacement: "*"}
	}
	rs := &RedactionSet{Patterns: pats}
	if err := rs.Compile(); err != nil {
		t.Fatalf("MaxPatternCount must be allowed, got %v", err)
	}
}

func TestDefaultSet_HasAllDefaultPatternsCompiled(t *testing.T) {
	s := DefaultSet()
	if len(s.Patterns) != len(DefaultPatterns) {
		t.Errorf("len(s.Patterns) = %d, want %d", len(s.Patterns), len(DefaultPatterns))
	}
	for i := range s.Patterns {
		if s.Patterns[i].Regex == nil {
			t.Errorf("Pattern %q not compiled", s.Patterns[i].Name)
		}
	}
	if s.TTLSeconds != 86400 {
		t.Errorf("TTLSeconds = %d, want 86400", s.TTLSeconds)
	}
	if s.Version == "" {
		t.Error("Version should be non-empty")
	}
}
