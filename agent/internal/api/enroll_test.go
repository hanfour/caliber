package api

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

func handlerReturning(status int, body string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(status)
		w.Write([]byte(body))
	})
}

func TestEnrollHappyPath(t *testing.T) {
	srv := httptest.NewServer(handlerReturning(201, `{"deviceId":"d-1","key":"cda_secret","keyPrefix":"cda_xxxx"}`))
	defer srv.Close()

	c := NewClient(srv.URL, "ua")
	resp, err := c.Enroll(context.Background(), EnrollRequest{Token: "t", Hostname: "h", OS: "o", AgentVersion: "v"})
	if err != nil {
		t.Fatalf("Enroll: %v", err)
	}
	if resp.DeviceID != "d-1" || resp.Key != "cda_secret" {
		t.Fatalf("resp = %+v", resp)
	}
}

func TestEnrollStatusToSentinel(t *testing.T) {
	cases := []struct {
		name   string
		status int
		body   string
		want   error
	}{
		{"401 invalid_token", 401, `{"error":"invalid_token"}`, ErrInvalidToken},
		{"410 token_already_used", 410, `{"error":"token_already_used"}`, ErrTokenUsed},
		{"410 token_expired", 410, `{"error":"token_expired"}`, ErrTokenExpired},
		{"500 server_misconfigured", 500, `{"error":"server_misconfigured"}`, ErrServerMisconf},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(handlerReturning(tc.status, tc.body))
			defer srv.Close()
			c := NewClient(srv.URL, "ua")
			_, err := c.Enroll(context.Background(), EnrollRequest{Token: "t", Hostname: "h", OS: "o", AgentVersion: "v"})
			if !errors.Is(err, tc.want) {
				t.Fatalf("err = %v, want %v", err, tc.want)
			}
			var apiErr *APIError
			if !errors.As(err, &apiErr) {
				t.Fatal("errors.As(err, *APIError) failed")
			}
			if apiErr.StatusCode != tc.status {
				t.Errorf("StatusCode = %d, want %d", apiErr.StatusCode, tc.status)
			}
		})
	}
}

func TestEnroll400ReturnsAPIErrorWithoutSentinel(t *testing.T) {
	srv := httptest.NewServer(handlerReturning(400, `{"error":"invalid_body","details":{}}`))
	defer srv.Close()
	c := NewClient(srv.URL, "ua")
	_, err := c.Enroll(context.Background(), EnrollRequest{Token: "t"})
	if errors.Is(err, ErrInvalidToken) {
		t.Fatal("400 invalid_body must not match ErrInvalidToken")
	}
	var apiErr *APIError
	if !errors.As(err, &apiErr) {
		t.Fatal("errors.As failed")
	}
	if apiErr.ErrorTag != "invalid_body" {
		t.Errorf("tag = %q", apiErr.ErrorTag)
	}
}

func TestEnrollBodyTruncatedTo200Chars(t *testing.T) {
	long := make([]byte, 1000)
	for i := range long {
		long[i] = 'x'
	}
	srv := httptest.NewServer(handlerReturning(500, string(long)))
	defer srv.Close()
	c := NewClient(srv.URL, "ua")
	_, err := c.Enroll(context.Background(), EnrollRequest{Token: "t"})
	var apiErr *APIError
	if !errors.As(err, &apiErr) {
		t.Fatal("errors.As failed")
	}
	if len(apiErr.Body) > 200 {
		t.Errorf("body = %d chars, want ≤ 200", len(apiErr.Body))
	}
}
