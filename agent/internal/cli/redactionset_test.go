package cli

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/hanfour/ai-dev-eval/agent/internal/api"
	"github.com/hanfour/ai-dev-eval/agent/internal/config"
	"github.com/hanfour/ai-dev-eval/agent/redact"
)

type captureLogger struct{ lines []string }

func (l *captureLogger) Printf(format string, args ...any) { l.lines = append(l.lines, format) }

func TestBootstrapRedactionSet_NoCache_FetchSucceeds(t *testing.T) {
	home := t.TempDir()
	t.Setenv("CALIBER_AGENT_HOME", home)
	// SaveRedactionSet's precheckRuntime requires config.toml; stub it.
	if err := os.WriteFile(filepath.Join(home, "config.toml"), []byte(""), 0o600); err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(200)
		w.Write([]byte(`{"patterns":[{"name":"n","regex":"[0-9]+","replacement":"#"}],"version":"v-1","ttl_seconds":3600}`))
	}))
	defer srv.Close()

	logger := &captureLogger{}
	prov, err := BootstrapRedactionSet(context.Background(), api.NewClient(srv.URL, "ua"), "cda_t", logger)
	if err != nil {
		t.Fatalf("Bootstrap: %v", err)
	}
	got := prov.Current()
	if got == nil || got.Version != "v-1" {
		t.Errorf("got = %+v", got)
	}
	loaded, err := config.LoadRedactionSet()
	if err != nil {
		t.Fatalf("LoadRedactionSet: %v", err)
	}
	if loaded.Version != "v-1" {
		t.Errorf("disk version = %q, want v-1", loaded.Version)
	}
}

func TestBootstrapRedactionSet_NoCache_FetchFails_FallsBackToDefault(t *testing.T) {
	t.Setenv("CALIBER_AGENT_HOME", t.TempDir())
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(500)
		w.Write([]byte(`{"error":"down"}`))
	}))
	defer srv.Close()
	logger := &captureLogger{}
	prov, err := BootstrapRedactionSet(context.Background(), api.NewClient(srv.URL, "ua"), "cda_t", logger)
	if err != nil {
		t.Fatalf("Bootstrap should not fail on fetch error when fallback exists: %v", err)
	}
	if prov.Current().Version != "bundled-default" {
		t.Errorf("expected bundled-default, got %q", prov.Current().Version)
	}
}

func TestBootstrapRedactionSet_CacheExists_NotExpired_NoFetch(t *testing.T) {
	home := t.TempDir()
	t.Setenv("CALIBER_AGENT_HOME", home)
	// SaveRedactionSet's precheckRuntime requires config.toml; stub it.
	if err := os.WriteFile(filepath.Join(home, "config.toml"), []byte(""), 0o600); err != nil {
		t.Fatal(err)
	}
	cached := &redact.RedactionSet{
		Patterns:   redact.DefaultPatterns,
		Version:    "v-cached",
		FetchedAt:  time.Now().Add(-time.Hour),
		TTLSeconds: 86400,
	}
	if err := config.SaveRedactionSet(cached); err != nil {
		t.Fatal(err)
	}
	hits := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hits++
		w.WriteHeader(200)
	}))
	defer srv.Close()
	prov, err := BootstrapRedactionSet(context.Background(), api.NewClient(srv.URL, "ua"), "cda_t", &captureLogger{})
	if err != nil {
		t.Fatal(err)
	}
	if prov.Current().Version != "v-cached" {
		t.Errorf("expected v-cached, got %q", prov.Current().Version)
	}
	if hits != 0 {
		t.Errorf("should not have called server, hits = %d", hits)
	}
}

func TestBootstrapRedactionSet_FatalErrorsPropagate(t *testing.T) {
	t.Setenv("CALIBER_AGENT_HOME", t.TempDir())
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(401)
		w.Write([]byte(`{"error":"key_revoked"}`))
	}))
	defer srv.Close()
	_, err := BootstrapRedactionSet(context.Background(), api.NewClient(srv.URL, "ua"), "cda_revoked", &captureLogger{})
	if !errors.Is(err, api.ErrKeyRevoked) {
		t.Errorf("err = %v, want ErrKeyRevoked", err)
	}
}
