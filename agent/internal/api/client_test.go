package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestClientSendsUserAgent(t *testing.T) {
	var gotUA string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotUA = r.Header.Get("User-Agent")
		w.WriteHeader(201)
		w.Write([]byte(`{"deviceId":"d","key":"cda_k","keyPrefix":"cda_"}`))
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "caliber-agent/dev")
	_, err := c.Enroll(context.Background(), EnrollRequest{Token: "t", Hostname: "h", OS: "o", AgentVersion: "v"})
	if err != nil {
		t.Fatalf("Enroll: %v", err)
	}
	if !strings.Contains(gotUA, "caliber-agent/dev") {
		t.Fatalf("User-Agent = %q", gotUA)
	}
}

func TestClientTimeoutFires(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(2 * time.Second)
		w.WriteHeader(201)
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "ua")
	c.HTTP.Timeout = 100 * time.Millisecond
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	_, err := c.Enroll(ctx, EnrollRequest{Token: "t", Hostname: "h", OS: "o", AgentVersion: "v"})
	if err == nil {
		t.Fatal("expected timeout error")
	}
}
