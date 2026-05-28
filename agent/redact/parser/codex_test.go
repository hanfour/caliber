package parser

import (
	"errors"
	"strings"
	"testing"
)

func TestParseCodexEvent_SessionMetaIsSkipLine(t *testing.T) {
	line := `{"type":"session_meta","payload":{"id":"s1","cwd":"/x"}}`
	_, err := ParseCodexEvent(line)
	if !errors.Is(err, ErrSkipLine) {
		t.Errorf("err = %v, want ErrSkipLine", err)
	}
}

func TestParseCodexEvent_Event(t *testing.T) {
	line := `{"timestamp":"2026-05-23T10:00:00Z","type":"event","payload":{"id":"e-1","parent_id":"e-0","type":"reasoning","role":"assistant","content":"thinking","usage":{"input_tokens":1,"output_tokens":2,"reasoning_output_tokens":3}}}`
	got, err := ParseCodexEvent(line)
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if got.EventID != "e-1" || got.ParentEventID != "e-0" || got.EventType != "reasoning" {
		t.Errorf("got = %+v", got)
	}
	if got.Role != "assistant" {
		t.Errorf("Role = %q", got.Role)
	}
	if got.Content != "thinking" {
		t.Errorf("Content = %v", got.Content)
	}
	if got.Tokens == nil || got.Tokens.Reasoning == nil || *got.Tokens.Reasoning != 3 {
		t.Errorf("Tokens.Reasoning wrong: %+v", got.Tokens)
	}
}

func TestParseCodexEvent_MalformedJSONIsNonSkipError(t *testing.T) {
	_, err := ParseCodexEvent("{not json")
	if err == nil {
		t.Fatal("expected error")
	}
	if errors.Is(err, ErrSkipLine) {
		t.Errorf("malformed JSON should NOT be ErrSkipLine; got %v", err)
	}
}

// Real codex transcripts only carry payload.id on `session_meta`. All other
// payload types (message, function_call, function_call_output, reasoning,
// token_count, task_started/_complete, turn_context, agent_message, ...)
// omit payload.id, so the parser must synthesize a stable per-line id to
// avoid sending empty event_id values that fail server-side validation
// (root cause behind #166: 1929 errors → 140KB response → agent's 64KB
// LimitReader truncates → counters report 0/0/0).
func TestParseCodexEvent_SynthesizesEventIDWhenPayloadIDMissing(t *testing.T) {
	line := `{"timestamp":"2026-05-23T10:00:00Z","type":"event","payload":{"type":"function_call","role":"assistant","content":"do_thing(x=1)"}}`
	got, err := ParseCodexEvent(line)
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if got.EventID == "" {
		t.Fatal("EventID should be synthesized, not empty")
	}
	if !strings.HasPrefix(got.EventID, "codex_") {
		t.Errorf("EventID = %q, want prefix \"codex_\"", got.EventID)
	}
	if len(got.EventID) < 16 {
		t.Errorf("EventID = %q too short to be unique", got.EventID)
	}
}

// Determinism: same byte-identical line → same synthetic id. Daemon
// retries (same transcript, same line) MUST produce the same event_id so
// server-side dedup works.
func TestParseCodexEvent_SyntheticIDIsStableAcrossCalls(t *testing.T) {
	line := `{"timestamp":"2026-05-23T10:00:00Z","type":"event","payload":{"type":"reasoning","content":"a"}}`
	a, err := ParseCodexEvent(line)
	if err != nil {
		t.Fatalf("err a = %v", err)
	}
	b, err := ParseCodexEvent(line)
	if err != nil {
		t.Fatalf("err b = %v", err)
	}
	if a.EventID == "" {
		t.Fatal("EventID empty — synthesis not applied")
	}
	if a.EventID != b.EventID {
		t.Errorf("non-deterministic: %q vs %q", a.EventID, b.EventID)
	}
}

// Different lines must produce different ids — otherwise app-level dedup
// would collapse distinct events.
func TestParseCodexEvent_SyntheticIDDistinguishesDifferentLines(t *testing.T) {
	a, _ := ParseCodexEvent(`{"timestamp":"2026-05-23T10:00:00Z","type":"event","payload":{"type":"reasoning","content":"a"}}`)
	b, _ := ParseCodexEvent(`{"timestamp":"2026-05-23T10:00:00Z","type":"event","payload":{"type":"reasoning","content":"b"}}`)
	if a.EventID == b.EventID {
		t.Errorf("distinct lines collided on EventID %q", a.EventID)
	}
}

// Explicit payload.id (e.g. session_meta — but also any future codex
// payload type that grows a native id) must take precedence over the
// synthesized hash so we keep continuity with whatever the upstream tool
// considers canonical.
func TestParseCodexEvent_ExplicitPayloadIDIsPreferred(t *testing.T) {
	line := `{"timestamp":"2026-05-23T10:00:00Z","type":"event","payload":{"id":"native-123","type":"message","content":"hi"}}`
	got, err := ParseCodexEvent(line)
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if got.EventID != "native-123" {
		t.Errorf("EventID = %q, want native-123 (explicit payload.id)", got.EventID)
	}
}

// Typeless-payload lines (turn_context, compacted) carry their kind at the
// top level, not under payload.type. Previously these were shipped with an
// empty event_type and dropped by the chunker. EventType must fall back to
// the top-level type, and the payload body (which holds the actual data —
// model/cwd/effort for turn_context) must be preserved as Content.
func TestParseCodexEvent_TurnContextUsesTopLevelTypeAndKeepsPayload(t *testing.T) {
	line := `{"timestamp":"2026-05-20T11:10:41Z","type":"turn_context","payload":{"turn_id":"t-1","cwd":"/Users/h/proj","model":"gpt-5","effort":"high"}}`
	got, err := ParseCodexEvent(line)
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if got.EventType != "turn_context" {
		t.Errorf("EventType = %q, want turn_context (top-level fallback)", got.EventType)
	}
	if got.EventID == "" {
		t.Error("EventID should be synthesized, not empty")
	}
	m, ok := got.Content.(map[string]any)
	if !ok {
		t.Fatalf("Content = %T, want map preserving payload", got.Content)
	}
	if m["model"] != "gpt-5" || m["cwd"] != "/Users/h/proj" {
		t.Errorf("Content lost payload fields: %v", m)
	}
}

func TestParseCodexEvent_CompactedUsesTopLevelTypeAndKeepsPayload(t *testing.T) {
	line := `{"timestamp":"2026-05-20T11:10:41Z","type":"compacted","payload":{"message":"summary text","replacement_history":[1,2]}}`
	got, err := ParseCodexEvent(line)
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if got.EventType != "compacted" {
		t.Errorf("EventType = %q, want compacted", got.EventType)
	}
	m, ok := got.Content.(map[string]any)
	if !ok {
		t.Fatalf("Content = %T, want map preserving payload", got.Content)
	}
	if m["message"] != "summary text" {
		t.Errorf("Content lost message field: %v", m)
	}
}

// Regression: typed-payload events (payload.type present) must keep using
// payload.type, NOT the generic top-level type (event_msg/response_item),
// and must NOT pick up the payload-as-Content fallback.
func TestParseCodexEvent_TypedPayloadUnaffectedByFallback(t *testing.T) {
	line := `{"timestamp":"2026-05-20T11:10:41Z","type":"response_item","payload":{"type":"function_call","content":"call(x)"}}`
	got, err := ParseCodexEvent(line)
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if got.EventType != "function_call" {
		t.Errorf("EventType = %q, want function_call (payload.type wins over top-level)", got.EventType)
	}
	if got.Content != "call(x)" {
		t.Errorf("Content = %v, want the payload.content string", got.Content)
	}
}

// A typed event with neither content nor result keeps Content nil — the
// payload-as-Content fallback is scoped to typeless-payload events only,
// so token_count (usage goes to Tokens) doesn't grow a redundant Content.
func TestParseCodexEvent_TypedPayloadWithoutContentStaysNil(t *testing.T) {
	line := `{"timestamp":"2026-05-20T11:10:41Z","type":"event_msg","payload":{"type":"token_count","usage":{"input_tokens":5}}}`
	got, err := ParseCodexEvent(line)
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if got.EventType != "token_count" {
		t.Errorf("EventType = %q, want token_count", got.EventType)
	}
	if got.Content != nil {
		t.Errorf("Content = %v, want nil (no fallback for typed events)", got.Content)
	}
	if got.Tokens == nil || got.Tokens.Input == nil || *got.Tokens.Input != 5 {
		t.Errorf("Tokens not parsed: %+v", got.Tokens)
	}
}
