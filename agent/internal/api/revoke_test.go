package api

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestRevokeSelf_204_Success(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodDelete || r.URL.Path != "/v1/devices/me" {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer cda_xyz" {
			t.Errorf("Authorization = %q", got)
		}
		if got := r.Header.Get("User-Agent"); got != "test" {
			t.Errorf("User-Agent = %q", got)
		}
		w.WriteHeader(204)
	}))
	defer srv.Close()
	c := &Client{BaseURL: srv.URL, UserAgent: "test", HTTP: &http.Client{Timeout: time.Second}}
	if err := c.RevokeSelf(context.Background(), "cda_xyz"); err != nil {
		t.Fatalf("want nil, got %v", err)
	}
}

func TestRevokeSelf_410_Idempotent_NoError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(410)
		_, _ = w.Write([]byte(`{"error":"device_already_revoked"}`))
	}))
	defer srv.Close()
	c := &Client{BaseURL: srv.URL, UserAgent: "t", HTTP: &http.Client{Timeout: time.Second}}
	if err := c.RevokeSelf(context.Background(), "cda_x"); err != nil {
		t.Fatalf("410 must be idempotent success, got %v", err)
	}
}

func TestRevokeSelf_401_InvalidToken(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(401)
		_, _ = w.Write([]byte(`{"error":"invalid_token"}`))
	}))
	defer srv.Close()
	c := &Client{BaseURL: srv.URL, UserAgent: "t", HTTP: &http.Client{Timeout: time.Second}}
	err := c.RevokeSelf(context.Background(), "cda_x")
	if !errors.Is(err, ErrInvalidToken) {
		t.Fatalf("want ErrInvalidToken, got %v", err)
	}
}

func TestRevokeSelf_401_KeyRevoked(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(401)
		_, _ = w.Write([]byte(`{"error":"key_revoked"}`))
	}))
	defer srv.Close()
	c := &Client{BaseURL: srv.URL, UserAgent: "t", HTTP: &http.Client{Timeout: time.Second}}
	err := c.RevokeSelf(context.Background(), "cda_x")
	if !errors.Is(err, ErrKeyRevoked) {
		t.Fatalf("want ErrKeyRevoked, got %v", err)
	}
}

func TestRevokeSelf_404_ReturnsAPIError_NotIdempotent(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(404)
		_, _ = w.Write([]byte(`{"error":"not_found"}`))
	}))
	defer srv.Close()
	c := &Client{BaseURL: srv.URL, UserAgent: "t", HTTP: &http.Client{Timeout: time.Second}}
	err := c.RevokeSelf(context.Background(), "cda_x")
	if err == nil {
		t.Fatalf("404 must NOT be treated as idempotent; got nil")
	}
	var apiErr *APIError
	if !errors.As(err, &apiErr) || apiErr.StatusCode != 404 {
		t.Fatalf("want APIError{Code:404}, got %v", err)
	}
}

func TestRevokeSelf_500_ReturnsAPIError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(500)
		_, _ = w.Write([]byte(`{"error":"internal"}`))
	}))
	defer srv.Close()
	c := &Client{BaseURL: srv.URL, UserAgent: "t", HTTP: &http.Client{Timeout: time.Second}}
	var apiErr *APIError
	err := c.RevokeSelf(context.Background(), "cda_x")
	if !errors.As(err, &apiErr) || apiErr.StatusCode != 500 {
		t.Fatalf("want APIError{Code:500}, got %v", err)
	}
}

func TestRevokeSelf_NetworkError_Wrapped(t *testing.T) {
	// Point at an unrouteable URL
	c := &Client{BaseURL: "http://127.0.0.1:1", UserAgent: "t", HTTP: &http.Client{Timeout: 100 * time.Millisecond}}
	err := c.RevokeSelf(context.Background(), "cda_x")
	if err == nil {
		t.Fatalf("want error, got nil")
	}
	var urlErr *url.Error
	if !errors.As(err, &urlErr) {
		// At minimum the error must mention revoke transport context
		if !strings.Contains(err.Error(), "revoke") {
			t.Fatalf("want network error, got %v", err)
		}
	}
}

func TestRevokeSelf_Body64KiBCap(t *testing.T) {
	huge := strings.Repeat("a", 1<<20)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(500)
		_, _ = w.Write([]byte(huge))
	}))
	defer srv.Close()
	c := &Client{BaseURL: srv.URL, UserAgent: "t", HTTP: &http.Client{Timeout: time.Second}}
	err := c.RevokeSelf(context.Background(), "cda_x")
	var apiErr *APIError
	if !errors.As(err, &apiErr) {
		t.Fatalf("want APIError, got %v", err)
	}
	// Body is first 200 chars (truncated) per APIError convention. Just
	// assert it stays under the 16 KiB read cap with generous slack so we
	// know we did not buffer the whole 1 MiB response.
	if got := len(apiErr.Body); got > 1<<14+100 {
		t.Fatalf("body must be capped near 16 KiB, got %d bytes", got)
	}
}
