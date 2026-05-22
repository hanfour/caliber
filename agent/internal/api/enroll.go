package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
)

type EnrollRequest struct {
	Token        string `json:"token"`
	Hostname     string `json:"hostname"`
	OS           string `json:"os"`
	AgentVersion string `json:"agentVersion"`
}

type EnrollResponse struct {
	DeviceID  string `json:"deviceId"`
	Key       string `json:"key"`
	KeyPrefix string `json:"keyPrefix"`
}

// errorBody is the shape of all 4xx/5xx responses from /v1/devices/enroll
// (see apps/api/src/rest/devicesEnroll.ts:39,134-149).
type errorBody struct {
	Error string `json:"error"`
}

func (c *Client) Enroll(ctx context.Context, req EnrollRequest) (*EnrollResponse, error) {
	payload, err := json.Marshal(req)
	if err != nil {
		return nil, fmt.Errorf("api: marshal enroll: %w", err)
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, c.BaseURL+"/v1/devices/enroll", bytes.NewReader(payload))
	if err != nil {
		return nil, fmt.Errorf("api: build request: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("User-Agent", c.UserAgent)

	resp, err := c.HTTP.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("api: enroll http: %w", err)
	}
	defer resp.Body.Close()

	bodyBytes, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<16)) // 64 KiB cap; real bodies are tiny

	if resp.StatusCode == http.StatusCreated {
		out := &EnrollResponse{}
		if err := json.Unmarshal(bodyBytes, out); err != nil {
			return nil, fmt.Errorf("api: parse 201 body: %w", err)
		}
		return out, nil
	}

	// Failure: parse the { error: "..." } shape into APIError.
	var eb errorBody
	_ = json.Unmarshal(bodyBytes, &eb) // best-effort; missing fields tolerated

	body := string(bodyBytes)
	if len(body) > 200 {
		body = body[:200]
	}
	return nil, &APIError{
		StatusCode: resp.StatusCode,
		ErrorTag:   eb.Error,
		Body:       body,
	}
}
