package service

import (
	"strings"
	"testing"
)

func TestRenderPlist(t *testing.T) {
	out, err := RenderPlist("/usr/local/bin/caliber-agent", "/home/u/.caliber-agent/agent.log")
	if err != nil {
		t.Fatalf("RenderPlist: %v", err)
	}
	for _, want := range []string{
		"<key>Label</key>", "<string>tw.caliber.agent</string>",
		"<string>/usr/local/bin/caliber-agent</string>", "<string>run</string>",
		"<key>KeepAlive</key>", "<key>RunAtLoad</key>",
		"/home/u/.caliber-agent/agent.log",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("plist missing %q", want)
		}
	}
	// XML-escape safety: a path with & must be escaped
	esc, _ := RenderPlist("/a&b/caliber-agent", "/l.log")
	if strings.Contains(esc, "/a&b/") || !strings.Contains(esc, "/a&amp;b/") {
		t.Error("exec path not XML-escaped")
	}
}

func TestLaunchAgentPath(t *testing.T) {
	p := LaunchAgentPath()
	if !strings.HasSuffix(p, "Library/LaunchAgents/tw.caliber.agent.plist") {
		t.Errorf("unexpected LaunchAgentPath: %q", p)
	}
}
