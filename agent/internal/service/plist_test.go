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
	// M2: KeepAlive must be scoped to SuccessfulExit=false (restart only on
	// crash/non-zero exit), not the bare <true/> form (restart on ANY exit,
	// including run.go's deliberate exit-0 paths — revoked device key /
	// uninstall sentinel — which would otherwise relaunch the daemon in a
	// tight loop hammering the server with revoked-key requests).
	if !strings.Contains(out, "<key>SuccessfulExit</key>") || !strings.Contains(out, "<false/>") {
		t.Errorf("plist missing KeepAlive/SuccessfulExit=false dict:\n%s", out)
	}
	keepAliveIdx := strings.Index(out, "<key>KeepAlive</key>")
	if keepAliveIdx < 0 {
		t.Fatalf("plist missing KeepAlive key")
	}
	afterKeepAlive := out[keepAliveIdx+len("<key>KeepAlive</key>"):]
	// The very next non-whitespace token after KeepAlive must be a <dict>,
	// not a bare <true/> (the old, buggy "restart on any exit" form).
	trimmed := strings.TrimSpace(afterKeepAlive)
	if !strings.HasPrefix(trimmed, "<dict>") {
		t.Errorf("KeepAlive must be followed by <dict>, not bare <true/>; got: %.60q", trimmed)
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
