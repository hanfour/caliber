package api

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestFetchRedactionSet_Happy(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/redaction-set" {
			t.Errorf("URL = %q", r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer cda_test" {
			t.Errorf("Authorization = %q", got)
		}
		w.WriteHeader(200)
		w.Write([]byte(`{"patterns":[{"name":"n","regex":"[0-9]+","replacement":"#"}],"version":"v-1","ttl_seconds":3600}`))
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "caliber-agent/test")
	got, err := c.FetchRedactionSet(context.Background(), "cda_test")
	if err != nil {
		t.Fatalf("FetchRedactionSet: %v", err)
	}
	if got.Version != "v-1" || got.TTLSeconds != 3600 || len(got.Patterns) != 1 {
		t.Errorf("got = %+v", got)
	}
}

func TestFetchRedactionSet_401InvalidToken(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(401)
		w.Write([]byte(`{"error":"invalid_token"}`))
	}))
	defer srv.Close()
	c := NewClient(srv.URL, "ua")
	_, err := c.FetchRedactionSet(context.Background(), "bad")
	if !errors.Is(err, ErrInvalidToken) {
		t.Errorf("err = %v, want ErrInvalidToken", err)
	}
}

func TestFetchRedactionSet_401KeyRevoked(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(401)
		w.Write([]byte(`{"error":"key_revoked"}`))
	}))
	defer srv.Close()
	c := NewClient(srv.URL, "ua")
	_, err := c.FetchRedactionSet(context.Background(), "cda_revoked")
	if !errors.Is(err, ErrKeyRevoked) {
		t.Errorf("err = %v, want ErrKeyRevoked", err)
	}
}

func TestFetchRedactionSet_500ReturnsAPIError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(500)
		w.Write([]byte(`{"error":"internal_error"}`))
	}))
	defer srv.Close()
	c := NewClient(srv.URL, "ua")
	_, err := c.FetchRedactionSet(context.Background(), "cda_test")
	var apiErr *APIError
	if !errors.As(err, &apiErr) {
		t.Fatalf("err = %v, want *APIError", err)
	}
	if apiErr.StatusCode != 500 {
		t.Errorf("StatusCode = %d, want 500", apiErr.StatusCode)
	}
}
