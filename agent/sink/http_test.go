package sink

import (
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/hanfour/ai-dev-eval/agent/internal/api"
	"github.com/hanfour/ai-dev-eval/agent/redact"
)

type capturedRequest struct {
	method     string
	path       string
	authHeader string
	contentEnc string
	contentTyp string
	body       map[string]any
}

func captureHandler(t *testing.T, status int, respBody string) (http.Handler, *capturedRequest) {
	t.Helper()
	cap := &capturedRequest{}
	h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cap.method = r.Method
		cap.path = r.URL.Path
		cap.authHeader = r.Header.Get("Authorization")
		cap.contentEnc = r.Header.Get("Content-Encoding")
		cap.contentTyp = r.Header.Get("Content-Type")
		var bodyReader io.Reader = r.Body
		if cap.contentEnc == "gzip" {
			gr, err := gzip.NewReader(r.Body)
			if err != nil {
				t.Fatalf("gunzip request: %v", err)
			}
			defer gr.Close()
			bodyReader = gr
		}
		raw, _ := io.ReadAll(bodyReader)
		_ = json.Unmarshal(raw, &cap.body)
		w.WriteHeader(status)
		w.Write([]byte(respBody))
	})
	return h, cap
}

func sampleChunk(source, sessionID string) Chunk {
	return Chunk{
		File:       "/tmp/" + sessionID + ".jsonl",
		Source:     source,
		SessionID:  sessionID,
		CWD:        "/Users/h/proj",
		Events:     []redact.Event{{EventID: "e-1", EventType: "user"}},
		FromOffset: 0,
		ToOffset:   100,
	}
}

func TestHTTPSink_Happy_PostsGzippedBodyAndReturnsNil(t *testing.T) {
	h, cap := captureHandler(t, 200, `{"ingested":1,"deduped":0,"session_upserts":1,"errors":[]}`)
	srv := httptest.NewServer(h)
	defer srv.Close()

	s := NewHTTPSink(HTTPSinkOpts{
		BaseURL:  srv.URL,
		Token:    "cda_test_key",
		DeviceID: "dev-1",
		Version:  "test",
		Mode:     redact.ModeMetadataOnly,
		HTTP:     &http.Client{Timeout: 5 * time.Second},
		Retry:    RetryPolicy{MaxAttempts: 1},
		Now:      time.Now,
		Logger:   &nopLogger{},
	})
	err := s.SendChunk(context.Background(), sampleChunk("claude", "s-1"))
	if err != nil {
		t.Fatalf("SendChunk: %v", err)
	}
	if cap.method != "POST" || cap.path != "/v1/ingest" {
		t.Errorf("got %s %s", cap.method, cap.path)
	}
	if cap.authHeader != "Bearer cda_test_key" {
		t.Errorf("Authorization = %q", cap.authHeader)
	}
	if cap.contentEnc != "gzip" {
		t.Errorf("Content-Encoding = %q", cap.contentEnc)
	}
	if cap.contentTyp != "application/json" {
		t.Errorf("Content-Type = %q", cap.contentTyp)
	}
	if cap.body["redaction_mode"] != "metadata-only" {
		t.Errorf("redaction_mode = %v", cap.body["redaction_mode"])
	}
	sessions, ok := cap.body["sessions"].([]any)
	if !ok || len(sessions) != 1 {
		t.Fatalf("sessions shape wrong: %T %v", cap.body["sessions"], cap.body["sessions"])
	}
}

func TestHTTPSink_SourceClient_MapsClaudeToClaudeCode(t *testing.T) {
	cases := []struct{ source, wantWire string }{
		{"claude", "claude-code"},
		{"claude-subagent", "claude-code"},
		{"codex", "codex"},
	}
	for _, tc := range cases {
		t.Run(tc.source, func(t *testing.T) {
			h, cap := captureHandler(t, 200, `{"ingested":1,"deduped":0,"session_upserts":1,"errors":[]}`)
			srv := httptest.NewServer(h)
			defer srv.Close()
			s := NewHTTPSink(HTTPSinkOpts{
				BaseURL: srv.URL, Token: "cda_t", DeviceID: "d", Version: "v",
				Mode: redact.ModeRedactedBody, HTTP: &http.Client{Timeout: 5 * time.Second},
				Retry: RetryPolicy{MaxAttempts: 1}, Now: time.Now, Logger: &nopLogger{},
			})
			_ = s.SendChunk(context.Background(), sampleChunk(tc.source, "s"))
			sessions := cap.body["sessions"].([]any)
			sess := sessions[0].(map[string]any)
			if sess["source_client"] != tc.wantWire {
				t.Errorf("source=%q -> source_client = %q, want %q", tc.source, sess["source_client"], tc.wantWire)
			}
		})
	}
}

type nopLogger struct{ lines []string }

func (l *nopLogger) Printf(format string, args ...any) {
	l.lines = append(l.lines, fmt.Sprintf(format, args...))
}

func TestHTTPSink_401InvalidToken_ReturnsErrInvalidToken(t *testing.T) {
	h, _ := captureHandler(t, 401, `{"error":"invalid_token"}`)
	srv := httptest.NewServer(h)
	defer srv.Close()
	s := NewHTTPSink(HTTPSinkOpts{
		BaseURL: srv.URL, Token: "cda_bad", DeviceID: "d", Version: "v",
		Mode:  redact.ModeMetadataOnly,
		HTTP:  &http.Client{Timeout: 5 * time.Second},
		Retry: RetryPolicy{MaxAttempts: 1}, Now: time.Now, Logger: &nopLogger{},
	})
	err := s.SendChunk(context.Background(), sampleChunk("claude", "s"))
	if !errors.Is(err, api.ErrInvalidToken) {
		t.Errorf("err = %v, want ErrInvalidToken", err)
	}
	var apiErr *api.APIError
	if !errors.As(err, &apiErr) {
		t.Errorf("err should also be *api.APIError")
	}
}

func TestHTTPSink_401KeyRevoked_ReturnsErrKeyRevoked(t *testing.T) {
	h, _ := captureHandler(t, 401, `{"error":"key_revoked"}`)
	srv := httptest.NewServer(h)
	defer srv.Close()
	s := NewHTTPSink(HTTPSinkOpts{
		BaseURL: srv.URL, Token: "cda_rev", DeviceID: "d", Version: "v",
		Mode: redact.ModeMetadataOnly, HTTP: &http.Client{Timeout: 5 * time.Second},
		Retry: RetryPolicy{MaxAttempts: 1}, Now: time.Now, Logger: &nopLogger{},
	})
	err := s.SendChunk(context.Background(), sampleChunk("claude", "s"))
	if !errors.Is(err, api.ErrKeyRevoked) {
		t.Errorf("err = %v, want ErrKeyRevoked", err)
	}
}

func TestHTTPSink_409SessionOwned_NoRetryNoAdvance(t *testing.T) {
	hits := 0
	h := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hits++
		w.WriteHeader(409)
		w.Write([]byte(`{"error":"SESSION_OWNED_BY_OTHER_ORG","ingested":0,"deduped":0,"session_upserts":0,"errors":[]}`))
	})
	srv := httptest.NewServer(h)
	defer srv.Close()
	s := NewHTTPSink(HTTPSinkOpts{
		BaseURL: srv.URL, Token: "cda_t", DeviceID: "d", Version: "v",
		Mode: redact.ModeMetadataOnly, HTTP: &http.Client{Timeout: 5 * time.Second},
		Retry: RetryPolicy{MaxAttempts: 5}, Now: time.Now, Logger: &nopLogger{},
	})
	err := s.SendChunk(context.Background(), sampleChunk("claude", "s"))
	if err == nil {
		t.Fatal("expected error on 409")
	}
	if hits != 1 {
		t.Errorf("expected exactly 1 hit (no retry on 409), got %d", hits)
	}
}

func TestHTTPSink_5xxRetriesUpToMaxAttempts(t *testing.T) {
	hits := 0
	h := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hits++
		w.WriteHeader(503)
		w.Write([]byte(`{"error":"unavailable"}`))
	})
	srv := httptest.NewServer(h)
	defer srv.Close()
	s := NewHTTPSink(HTTPSinkOpts{
		BaseURL: srv.URL, Token: "cda_t", DeviceID: "d", Version: "v",
		Mode: redact.ModeMetadataOnly, HTTP: &http.Client{Timeout: 5 * time.Second},
		Retry: RetryPolicy{MaxAttempts: 3, InitialBackoff: time.Millisecond, MaxJitter: time.Millisecond},
		Now:   time.Now, Logger: &nopLogger{},
	})
	err := s.SendChunk(context.Background(), sampleChunk("claude", "s"))
	if err == nil {
		t.Fatal("expected error after retry exhaust")
	}
	if hits != 3 {
		t.Errorf("expected 3 hits, got %d", hits)
	}
}

func TestHTTPSink_429RetriesAndSucceeds(t *testing.T) {
	hits := 0
	h := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hits++
		if hits < 2 {
			w.WriteHeader(429)
			w.Write([]byte(`{"error":"rate_limit"}`))
			return
		}
		w.WriteHeader(200)
		w.Write([]byte(`{"ingested":1,"deduped":0,"session_upserts":1,"errors":[]}`))
	})
	srv := httptest.NewServer(h)
	defer srv.Close()
	s := NewHTTPSink(HTTPSinkOpts{
		BaseURL: srv.URL, Token: "cda_t", DeviceID: "d", Version: "v",
		Mode: redact.ModeMetadataOnly, HTTP: &http.Client{Timeout: 5 * time.Second},
		Retry: RetryPolicy{MaxAttempts: 3, InitialBackoff: time.Millisecond, RateLimitBase: time.Millisecond, MaxJitter: time.Millisecond},
		Now:   time.Now, Logger: &nopLogger{},
	})
	err := s.SendChunk(context.Background(), sampleChunk("claude", "s"))
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if hits != 2 {
		t.Errorf("hits = %d, want 2", hits)
	}
}

func TestHTTPSink_200WithErrorsBodyStillReturnsNil(t *testing.T) {
	h, _ := captureHandler(t, 200, `{"ingested":2,"deduped":0,"session_upserts":1,"errors":[{"session_id":"s","error":"events_insert_failed"}]}`)
	srv := httptest.NewServer(h)
	defer srv.Close()
	logger := &nopLogger{}
	s := NewHTTPSink(HTTPSinkOpts{
		BaseURL: srv.URL, Token: "cda_t", DeviceID: "d", Version: "v",
		Mode: redact.ModeMetadataOnly, HTTP: &http.Client{Timeout: 5 * time.Second},
		Retry: RetryPolicy{MaxAttempts: 1}, Now: time.Now, Logger: logger,
	})
	err := s.SendChunk(context.Background(), sampleChunk("claude", "s"))
	if err != nil {
		t.Errorf("200 with errors[] should still return nil (advance watermark); got %v", err)
	}
}

func TestHTTPSink_CtxCancelMidRetryAborts(t *testing.T) {
	h := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(503)
	})
	srv := httptest.NewServer(h)
	defer srv.Close()
	s := NewHTTPSink(HTTPSinkOpts{
		BaseURL: srv.URL, Token: "cda_t", DeviceID: "d", Version: "v",
		Mode: redact.ModeMetadataOnly, HTTP: &http.Client{Timeout: 5 * time.Second},
		Retry: RetryPolicy{MaxAttempts: 5, InitialBackoff: 100 * time.Millisecond, MaxJitter: time.Millisecond},
		Now:   time.Now, Logger: &nopLogger{},
	})
	ctx, cancel := context.WithCancel(context.Background())
	go func() { time.Sleep(50 * time.Millisecond); cancel() }()
	err := s.SendChunk(ctx, sampleChunk("claude", "s"))
	if err == nil {
		t.Fatal("expected ctx.Canceled-related error")
	}
}

// Regression for #166: server returns a valid 200 whose body is larger
// than the old 64KB read cap. The agent must still parse counters
// correctly and log accurate numbers instead of silently reporting zeros.
//
// Concrete repro: a codex transcript with ~1900 events that all fail
// server schema validation produces a ~140KB JSON response carrying a
// per-event error[] array. Pre-fix, io.LimitReader(resp.Body, 1<<16)
// truncated mid-array, json.Unmarshal failed silently, and the agent
// logged "events=N ingested=0 deduped=0 errors=0" — exactly the symptom
// in the bug report.
func TestHTTPSink_LargeResponseBodyParsedCorrectly(t *testing.T) {
	const errorCount = 2000
	var b strings.Builder
	b.WriteString(`{"ingested":0,"deduped":0,"session_upserts":1,"errors":[`)
	for i := 0; i < errorCount; i++ {
		if i > 0 {
			b.WriteString(",")
		}
		fmt.Fprintf(&b, `{"session_id":"s-abc","event_id":"e-%d","error":"malformed_event"}`, i)
	}
	b.WriteString(`]}`)
	respBody := b.String()
	if len(respBody) <= 1<<16 {
		t.Fatalf("test setup: response too small (%d bytes); want >64KB to exercise old LimitReader cap", len(respBody))
	}

	h, _ := captureHandler(t, 200, respBody)
	srv := httptest.NewServer(h)
	defer srv.Close()
	logger := &nopLogger{}
	s := NewHTTPSink(HTTPSinkOpts{
		BaseURL: srv.URL, Token: "cda_t", DeviceID: "d", Version: "v",
		Mode: redact.ModeMetadataOnly, HTTP: &http.Client{Timeout: 5 * time.Second},
		Retry: RetryPolicy{MaxAttempts: 1}, Now: time.Now, Logger: logger,
	})
	if err := s.SendChunk(context.Background(), sampleChunk("claude", "s-abc")); err != nil {
		t.Fatalf("SendChunk = %v", err)
	}

	var ingestLine string
	for _, line := range logger.lines {
		if strings.HasPrefix(line, "[ingest] ") {
			ingestLine = line
			break
		}
	}
	if ingestLine == "" {
		t.Fatalf("missing [ingest] log line; lines = %v", logger.lines)
	}
	want := fmt.Sprintf("errors=%d", errorCount)
	if !strings.Contains(ingestLine, want) {
		t.Errorf("log line should reflect actual error count %d; got: %s", errorCount, ingestLine)
	}
}

// When the response body is unparseable (truncated, non-JSON, or future
// schema mismatch), the agent must NOT silently log zeros. It should
// emit a [warn] line so the operator can see something went wrong, then
// still log the [ingest] line so watermark progress is visible. Send is
// not failed — the request did succeed at the HTTP layer.
func TestHTTPSink_UnparseableResponseBodySurfacesWarning(t *testing.T) {
	h, _ := captureHandler(t, 200, `{ this is not json`)
	srv := httptest.NewServer(h)
	defer srv.Close()
	logger := &nopLogger{}
	s := NewHTTPSink(HTTPSinkOpts{
		BaseURL: srv.URL, Token: "cda_t", DeviceID: "d", Version: "v",
		Mode: redact.ModeMetadataOnly, HTTP: &http.Client{Timeout: 5 * time.Second},
		Retry: RetryPolicy{MaxAttempts: 1}, Now: time.Now, Logger: logger,
	})
	if err := s.SendChunk(context.Background(), sampleChunk("claude", "s")); err != nil {
		t.Fatalf("SendChunk = %v; want nil (200 still advances watermark)", err)
	}
	sawWarn := false
	for _, line := range logger.lines {
		if strings.Contains(line, "[warn]") && strings.Contains(line, "response") {
			sawWarn = true
			break
		}
	}
	if !sawWarn {
		t.Errorf("expected a [warn] log about response parse; got: %v", logger.lines)
	}
}
