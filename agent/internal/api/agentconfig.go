package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
)

// AgentConfigResponse is the wire shape of GET /v1/agent-config.
type AgentConfigResponse struct {
	PollIntervalSeconds int64 `json:"poll_interval_seconds"`
	TTLSeconds          int64 `json:"ttl_seconds"`
}

// FetchAgentConfig GETs /v1/agent-config with Bearer cda_* auth.
// On 200: returns the parsed response.
// On 401: returns *APIError wrapping ErrInvalidToken or ErrKeyRevoked
// depending on the body's "error" field.
// On 5xx: returns *APIError.
// On network failure: returns wrapped *url.Error.
func (c *Client) FetchAgentConfig(ctx context.Context, token string) (*AgentConfigResponse, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.BaseURL+"/v1/agent-config", nil)
	if err != nil {
		return nil, fmt.Errorf("api: build agent-config request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("User-Agent", c.UserAgent)

	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, fmt.Errorf("api: agent-config http: %w", err)
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<16)) // 64 KiB cap

	if resp.StatusCode == http.StatusOK {
		out := &AgentConfigResponse{}
		if err := json.NewDecoder(bytes.NewReader(body)).Decode(out); err != nil {
			return nil, fmt.Errorf("api: parse agent-config 200: %w", err)
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
