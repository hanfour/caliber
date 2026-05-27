package api

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
)

// RevokeSelf calls DELETE /v1/devices/me with the daemon's cda_* token.
//
// Status mapping (spec §5.5):
//
//   - 204 (first revoke) and 410 device_already_revoked → nil (idempotent
//     success).
//   - 401 → *APIError carrying ErrorTag, which APIError.Is maps to
//     ErrKeyRevoked ("key_revoked"/"device_revoked") or ErrInvalidToken
//     ("invalid_token"). Callers use errors.Is to dispatch.
//   - 404 → *APIError{StatusCode:404} — NOT idempotent (R5-F4). The endpoint
//     genuinely should not be missing on a deployed server, so we surface it.
//   - 5xx and any other non-2xx → *APIError.
//   - Network/transport failure → wrapped error from c.HTTP.Do.
//
// Response bodies are bounded by io.LimitReader at 16 KiB to keep memory
// pressure low on a misbehaving server.
func (c *Client) RevokeSelf(ctx context.Context, token string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, c.BaseURL+"/v1/devices/me", nil)
	if err != nil {
		return fmt.Errorf("api: build revoke request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("User-Agent", c.UserAgent)

	resp, err := c.HTTP.Do(req)
	if err != nil {
		return fmt.Errorf("api: revoke http: %w", err)
	}
	defer resp.Body.Close()

	// 204: idempotent success, no body to read.
	if resp.StatusCode == http.StatusNoContent {
		return nil
	}

	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<14)) // 16 KiB cap
	var eb struct {
		Error string `json:"error"`
	}
	_ = json.Unmarshal(body, &eb) // best-effort; missing/invalid JSON tolerated

	// 410: idempotent success regardless of body (spec §5.5).
	if resp.StatusCode == http.StatusGone {
		return nil
	}

	truncated := string(body)
	if len(truncated) > 200 {
		truncated = truncated[:200]
	}
	// APIError.Is(ErrInvalidToken / ErrKeyRevoked) handles 401 sentinel
	// matching, so callers can use either errors.Is or errors.As without
	// a separate wrapper type.
	return &APIError{
		StatusCode: resp.StatusCode,
		ErrorTag:   eb.Error,
		Body:       truncated,
	}
}
