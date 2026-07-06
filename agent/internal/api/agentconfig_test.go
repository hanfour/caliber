package api

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestFetchAgentConfig_Happy(t *testing.T) {
	var gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/agent-config" {
			t.Errorf("URL = %q", r.URL.Path)
		}
		gotAuth = r.Header.Get("Authorization")
		w.WriteHeader(200)
		w.Write([]byte(`{"poll_interval_seconds":300,"ttl_seconds":3600}`))
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "caliber-agent/test")
	resp, err := c.FetchAgentConfig(context.Background(), "cda_token")
	if err != nil {
		t.Fatalf("FetchAgentConfig: %v", err)
	}
	if gotAuth != "Bearer cda_token" {
		t.Errorf("Authorization = %q", gotAuth)
	}
	if resp.PollIntervalSeconds != 300 || resp.TTLSeconds != 3600 {
		t.Fatalf("got %+v", resp)
	}
}

func TestFetchAgentConfig_401InvalidToken(t *testing.T) {
	srv := httptest.NewServer(handlerReturning(401, `{"error":"invalid_token"}`))
	defer srv.Close()
	c := NewClient(srv.URL, "ua")
	_, err := c.FetchAgentConfig(context.Background(), "bad")
	if !errors.Is(err, ErrInvalidToken) {
		t.Errorf("err = %v, want ErrInvalidToken", err)
	}
}

func TestFetchAgentConfig_500ReturnsAPIError(t *testing.T) {
	srv := httptest.NewServer(handlerReturning(500, `{"error":"internal_error"}`))
	defer srv.Close()
	c := NewClient(srv.URL, "ua")
	_, err := c.FetchAgentConfig(context.Background(), "cda_test")
	var apiErr *APIError
	if !errors.As(err, &apiErr) {
		t.Fatalf("err = %v, want *APIError", err)
	}
	if apiErr.StatusCode != 500 {
		t.Errorf("StatusCode = %d, want 500", apiErr.StatusCode)
	}
}
