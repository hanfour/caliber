package redact

import (
	"encoding/json"
	"strings"
)

// Mode controls how aggressively content is redacted before upload.
type Mode string

const (
	ModeMetadataOnly Mode = "metadata-only"
	ModeRedactedBody Mode = "redacted-body"
	ModeFullBody     Mode = "full-body"
)

// ApplyMode returns a redacted COPY of e per mode + patterns. The
// original event is unmodified (callers can keep referring to it).
//
// metadata-only:  Content -> {length, preview}; secret-scrub NOT applied
//
//	(no content to scrub).
//
// redacted-body:  Content walked recursively; every string runs through
//
//	ScrubString(patterns).
//
// full-body:      Same as redacted-body — spec is explicit that
//
//	secret-scrub is always-on even in full-body.
func ApplyMode(e Event, mode Mode, patterns []Pattern) Event {
	out := e // copy; fields are pass-by-value or pointers we DON'T mutate
	switch mode {
	case ModeMetadataOnly:
		out.Content = stripToSummary(e.Content)
	case ModeRedactedBody, ModeFullBody:
		out.Content = scrubAny(e.Content, patterns)
	}
	return out
}

func stripToSummary(content any) any {
	if content == nil {
		return map[string]any{"length": 0, "preview": ""}
	}
	raw, _ := json.Marshal(content)
	length := len(raw)
	preview := ""
	switch v := content.(type) {
	case string:
		preview = firstNWords(v, 3)
	case []any:
		// Look for the first tool_use entry; use <tool:<name>> form.
		for _, item := range v {
			m, ok := item.(map[string]any)
			if !ok {
				continue
			}
			if m["type"] == "tool_use" {
				if name, ok := m["name"].(string); ok {
					preview = "<tool:" + name + ">"
					break
				}
			}
		}
	case map[string]any:
		if t, ok := v["type"].(string); ok && t == "tool_use" {
			if name, ok := v["name"].(string); ok {
				preview = "<tool:" + name + ">"
			}
		}
	}
	return map[string]any{"length": length, "preview": preview}
}

func firstNWords(s string, n int) string {
	fields := strings.Fields(s)
	if len(fields) > n {
		fields = fields[:n]
	}
	return strings.Join(fields, " ")
}

// scrubAny walks an arbitrary JSON-ish value and applies ScrubString to
// every string node. Maps and slices are recursed; primitives other
// than string are passed through. Returns a new value tree (input not
// mutated) so ApplyMode keeps the original Event content intact.
func scrubAny(v any, patterns []Pattern) any {
	switch x := v.(type) {
	case nil:
		return nil
	case string:
		return ScrubString(x, patterns)
	case []any:
		out := make([]any, len(x))
		for i, item := range x {
			out[i] = scrubAny(item, patterns)
		}
		return out
	case map[string]any:
		out := make(map[string]any, len(x))
		for k, item := range x {
			out[k] = scrubAny(item, patterns)
		}
		return out
	default:
		// numbers, bools, etc — pass through
		return v
	}
}
