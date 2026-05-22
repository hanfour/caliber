package config

import (
	"bytes"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"
)

func TestOpenAgentLog_CreatesAt0600(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("CALIBER_AGENT_HOME", tmp)

	f, err := OpenAgentLog()
	if err != nil {
		t.Fatalf("OpenAgentLog: %v", err)
	}
	defer f.Close()

	info, err := os.Stat(filepath.Join(tmp, "agent.log"))
	if err != nil {
		t.Fatalf("Stat: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Errorf("perm = %o, want 0600", perm)
	}
}

func TestOpenAgentLog_AppendsAcrossReopens(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("CALIBER_AGENT_HOME", tmp)

	f1, err := OpenAgentLog()
	if err != nil {
		t.Fatalf("first open: %v", err)
	}
	if _, err := f1.WriteString("line-1\n"); err != nil {
		t.Fatal(err)
	}
	f1.Close()

	f2, err := OpenAgentLog()
	if err != nil {
		t.Fatalf("second open: %v", err)
	}
	if _, err := f2.WriteString("line-2\n"); err != nil {
		t.Fatal(err)
	}
	f2.Close()

	bs, err := os.ReadFile(filepath.Join(tmp, "agent.log"))
	if err != nil {
		t.Fatal(err)
	}
	got := string(bs)
	if !strings.Contains(got, "line-1") || !strings.Contains(got, "line-2") {
		t.Errorf("expected both lines, got %q", got)
	}
}

func TestRFCLogger_PrependsTimestamp(t *testing.T) {
	var buf bytes.Buffer
	l := NewRFCLogger(&buf)
	l.Now = func() time.Time {
		return time.Date(2026, 5, 22, 11, 14, 2, 0, time.UTC)
	}
	l.Printf("[chunk] file=%s events=%d", "/tmp/x", 3)
	got := buf.String()
	if got != "2026-05-22T11:14:02Z [chunk] file=/tmp/x events=3\n" {
		t.Errorf("got %q", got)
	}
}

func TestRFCLogger_RFC3339UTC_RegexMatch(t *testing.T) {
	var buf bytes.Buffer
	l := NewRFCLogger(&buf)
	// default Now -> real time.Now; just check format shape.
	l.Printf("hello")
	got := buf.String()
	re := regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z hello\n$`)
	if !re.MatchString(got) {
		t.Errorf("output doesn't match RFC3339 UTC pattern: %q", got)
	}
}

func TestRFCLogger_ArgsInterpolatedOnce(t *testing.T) {
	// Guard: if the implementation formatted twice (e.g. by accident
	// using Sprintf then Fprintf with format-rendered string), %d-like
	// directives in user data could double-expand.
	var buf bytes.Buffer
	l := NewRFCLogger(&buf)
	l.Now = func() time.Time { return time.Unix(0, 0).UTC() }
	l.Printf("payload=%s", "100%% complete")
	got := buf.String()
	if !regexp.MustCompile(`payload=100%% complete\n$`).MatchString(got) {
		t.Errorf("args double-formatted: %q", got)
	}
}
