package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"

	"github.com/hanfour/ai-dev-eval/agent/redact"
)

// RedactionSetResponse is the wire shape of GET /v1/redaction-set.
type RedactionSetResponse struct {
	Patterns   []redact.Pattern `json:"patterns"`
	Version    string           `json:"version"`
	TTLSeconds int64            `json:"ttl_seconds"`
}

// FetchRedactionSet GETs /v1/redaction-set with Bearer cda_* auth.
// On 200: returns the parsed response.
// On 401: returns *APIError wrapping ErrInvalidToken or ErrKeyRevoked
// depending on the body's "error" field.
// On 5xx: returns *APIError.
// On network failure: returns wrapped *url.Error.
func (c *Client) FetchRedactionSet(ctx context.Context, token string) (*RedactionSetResponse, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.BaseURL+"/v1/redaction-set", nil)
	if err != nil {
		return nil, fmt.Errorf("api: build redaction-set request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("User-Agent", c.UserAgent)

	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, fmt.Errorf("api: redaction-set http: %w", err)
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<16)) // 64 KiB cap

	if resp.StatusCode == http.StatusOK {
		out := &RedactionSetResponse{}
		if err := json.NewDecoder(bytes.NewReader(body)).Decode(out); err != nil {
			return nil, fmt.Errorf("api: parse redaction-set 200: %w", err)
		}
		return out, nil
	}

	var eb struct {
		Error string `json:"error"`
	}
	_ = json.Unmarshal(body, &eb)
	truncated := string(body)
	if len(truncated) > 200 {
		truncated = truncated[:200]
	}
	return nil, &APIError{StatusCode: resp.StatusCode, ErrorTag: eb.Error, Body: truncated}
}
