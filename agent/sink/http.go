package sink

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/hanfour/ai-dev-eval/agent/internal/api"
	"github.com/hanfour/ai-dev-eval/agent/redact"
)

// Logger matches watcher.Logger / config.RFCLogger shape so callers can
// pass either without an adapter.
type Logger interface {
	Printf(format string, args ...any)
}

// HTTPSink POSTs gzipped Chunks to /v1/ingest with Bearer cda_* auth.
// Replaces LogSink as the production Sink at PR3.
type HTTPSink struct {
	BaseURL  string
	Token    string
	DeviceID string
	Version  string
	Mode     redact.Mode
	HTTP     *http.Client
	Retry    RetryPolicy
	Now      func() time.Time
	Logger   Logger
}

// RetryPolicy is the backoff configuration for transient HTTP errors.
type RetryPolicy struct {
	MaxAttempts    int           // default 5
	InitialBackoff time.Duration // default 1s (5xx + network)
	RateLimitBase  time.Duration // default 30s (429)
	MaxJitter      time.Duration // default 250ms
}

// HTTPSinkOpts is the constructor argument.
type HTTPSinkOpts struct {
	BaseURL  string
	Token    string
	DeviceID string
	Version  string
	Mode     redact.Mode
	HTTP     *http.Client
	Retry    RetryPolicy
	Now      func() time.Time
	Logger   Logger
}

// NewHTTPSink creates an HTTPSink with defaults applied.
func NewHTTPSink(opts HTTPSinkOpts) *HTTPSink {
	if opts.Now == nil {
		opts.Now = time.Now
	}
	if opts.HTTP == nil {
		opts.HTTP = &http.Client{Timeout: 30 * time.Second}
	}
	if opts.Retry.MaxAttempts == 0 {
		opts.Retry.MaxAttempts = 5
	}
	if opts.Retry.InitialBackoff == 0 {
		opts.Retry.InitialBackoff = time.Second
	}
	if opts.Retry.RateLimitBase == 0 {
		opts.Retry.RateLimitBase = 30 * time.Second
	}
	if opts.Retry.MaxJitter == 0 {
		opts.Retry.MaxJitter = 250 * time.Millisecond
	}
	return &HTTPSink{
		BaseURL:  opts.BaseURL,
		Token:    opts.Token,
		DeviceID: opts.DeviceID,
		Version:  opts.Version,
		Mode:     opts.Mode,
		HTTP:     opts.HTTP,
		Retry:    opts.Retry,
		Now:      opts.Now,
		Logger:   opts.Logger,
	}
}

// ingestSession matches the server zod schema in
// apps/api/src/rest/ingest.ts sessionSchema.
type ingestSession struct {
	SessionID       string         `json:"session_id"`
	ParentSessionID string         `json:"parent_session_id,omitempty"`
	SourceClient    string         `json:"source_client"`
	Static          sessionStatic  `json:"static"`
	Events          []redact.Event `json:"events"`
}

type sessionStatic struct {
	CWD string `json:"cwd,omitempty"`
}

type ingestBody struct {
	DeviceID      string          `json:"device_id"`
	AgentVersion  string          `json:"agent_version"`
	RedactionMode redact.Mode     `json:"redaction_mode"`
	Sessions      []ingestSession `json:"sessions"`
}

type ingestResponse struct {
	Ingested       int `json:"ingested"`
	Deduped        int `json:"deduped"`
	SessionUpserts int `json:"session_upserts"`
	Errors         []struct {
		SessionID string `json:"session_id,omitempty"`
		EventID   string `json:"event_id,omitempty"`
		Error     string `json:"error"`
	} `json:"errors"`
}

// authError wraps an *api.APIError with a sentinel so callers can use
// both errors.Is(err, api.ErrInvalidToken) and errors.As(err, &apiErr).
type authError struct {
	sentinel error
	cause    *api.APIError
}

func (e *authError) Error() string        { return fmt.Sprintf("%s: %s", e.sentinel, e.cause) }
func (e *authError) Is(target error) bool { return target == e.sentinel || errors.Is(e.cause, target) }
func (e *authError) As(target any) bool {
	if t, ok := target.(**api.APIError); ok {
		*t = e.cause
		return true
	}
	return false
}
func (e *authError) Unwrap() error { return e.cause }

// SendChunk implements Sink. It marshals the Chunk into a gzipped JSON
// payload and POSTs it to /v1/ingest with Bearer token auth. Transient
// errors (5xx, 429, network) are retried per RetryPolicy; auth failures
// (401) and permanent errors (400, 409, 410) are returned immediately.
func (h *HTTPSink) SendChunk(ctx context.Context, c Chunk) error {
	body := ingestBody{
		DeviceID:      h.DeviceID,
		AgentVersion:  h.Version,
		RedactionMode: h.Mode,
		Sessions: []ingestSession{{
			SessionID:       c.SessionID,
			ParentSessionID: c.ParentSessionID,
			SourceClient:    mapSourceClient(c.Source),
			Static:          sessionStatic{CWD: c.CWD},
			Events:          c.Events,
		}},
	}
	raw, err := json.Marshal(body)
	if err != nil {
		return fmt.Errorf("httpsink: marshal: %w", err)
	}
	var gzBuf bytes.Buffer
	gw := gzip.NewWriter(&gzBuf)
	if _, err := gw.Write(raw); err != nil {
		return fmt.Errorf("httpsink: gzip write: %w", err)
	}
	if err := gw.Close(); err != nil {
		return fmt.Errorf("httpsink: gzip close: %w", err)
	}
	wireBytes := gzBuf.Len()
	gzBytes := gzBuf.Bytes()

	var lastErr error
	for attempt := 0; attempt < h.Retry.MaxAttempts; attempt++ {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, h.BaseURL+"/v1/ingest", bytes.NewReader(gzBytes))
		if err != nil {
			return fmt.Errorf("httpsink: build request: %w", err)
		}
		req.Header.Set("Authorization", "Bearer "+h.Token)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Content-Encoding", "gzip")

		start := h.Now()
		resp, herr := h.HTTP.Do(req)
		if herr != nil {
			// Network/transport failure — retry like 5xx.
			lastErr = fmt.Errorf("httpsink: http: %w", herr)
			if !h.sleepBackoff(ctx, attempt, h.Retry.InitialBackoff) {
				return ctx.Err()
			}
			continue
		}
		// Response cap of 4 MiB. The success body grows with errors[]
		// (one entry per malformed event). #166 was caused by the old
		// 64 KiB cap: a 1929-event codex chunk with missing event_ids
		// produced a ~140 KiB error array, the reader truncated
		// mid-array, json.Unmarshal failed silently, and the agent
		// logged ingested=0/deduped=0/errors=0 while the server had
		// inserted the session row and recorded the validation errors.
		respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<22))
		resp.Body.Close()

		if resp.StatusCode == http.StatusOK {
			var ir ingestResponse
			if uerr := json.Unmarshal(respBody, &ir); uerr != nil && h.Logger != nil {
				h.Logger.Printf("[warn] sink: parse ingest response (sess=%s bytes=%d): %v",
					c.SessionID, len(respBody), uerr)
			}
			h.logIngest(c, &ir, wireBytes, h.Now().Sub(start))
			return nil
		}

		apiErr := h.toAPIError(resp.StatusCode, respBody)
		var ae *api.APIError
		_ = errors.As(apiErr, &ae)

		switch {
		case ae.StatusCode == 401:
			if errors.Is(ae, api.ErrKeyRevoked) {
				return &authError{sentinel: api.ErrKeyRevoked, cause: ae}
			}
			return &authError{sentinel: api.ErrInvalidToken, cause: ae}
		case ae.StatusCode == 400 || ae.StatusCode == 409 || ae.StatusCode == 410:
			return apiErr
		case ae.StatusCode == 429:
			lastErr = apiErr
			if !h.sleepBackoff(ctx, attempt, h.Retry.RateLimitBase) {
				return ctx.Err()
			}
		case ae.StatusCode >= 500:
			lastErr = apiErr
			if !h.sleepBackoff(ctx, attempt, h.Retry.InitialBackoff) {
				return ctx.Err()
			}
		default:
			return apiErr
		}
	}
	return fmt.Errorf("httpsink: retry exhausted after %d attempts: %w", h.Retry.MaxAttempts, lastErr)
}

// sleepBackoff sleeps for base * 2^attempt + random jitter, honoring ctx.
// Returns false if ctx is cancelled mid-sleep.
func (h *HTTPSink) sleepBackoff(ctx context.Context, attempt int, base time.Duration) bool {
	d := base << attempt
	if h.Retry.MaxJitter > 0 {
		// Cheap jitter: use Now's nanoseconds modulo as a stand-in.
		jitter := time.Duration(h.Now().UnixNano()%int64(h.Retry.MaxJitter)) * time.Nanosecond
		d += jitter
	}
	select {
	case <-time.After(d):
		return true
	case <-ctx.Done():
		return false
	}
}

func mapSourceClient(source string) string {
	switch source {
	case "claude", "claude-subagent":
		return "claude-code"
	case "codex":
		return "codex"
	default:
		return source
	}
}

func (h *HTTPSink) logIngest(c Chunk, r *ingestResponse, wireBytes int, dur time.Duration) {
	if h.Logger == nil {
		return
	}
	h.Logger.Printf("[ingest] sess=%s events=%d ingested=%d deduped=%d errors=%d bytes=%d duration=%s",
		c.SessionID, len(c.Events), r.Ingested, r.Deduped, len(r.Errors), wireBytes, dur)
}

func (h *HTTPSink) toAPIError(status int, body []byte) error {
	var eb struct {
		Error string `json:"error"`
	}
	_ = json.Unmarshal(body, &eb)
	truncated := string(body)
	if len(truncated) > 200 {
		truncated = truncated[:200]
	}
	return &api.APIError{StatusCode: status, ErrorTag: eb.Error, Body: truncated}
}
