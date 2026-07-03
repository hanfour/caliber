// Package service builds the launchd LaunchAgent property list used to run
// caliber-agent resident on macOS (install-service / uninstall-service).
// It has no build tag so RenderPlist / LaunchAgentPath are testable on any
// platform; only the cli commands that shell out to launchctl are
// darwin-gated.
package service

import (
	"bytes"
	"encoding/xml"
	"os"
	"path/filepath"
	"text/template"
)

// LaunchAgentLabel is the launchd job label, matching the keychain
// ServiceName for repo-internal consistency (not the spec's net.miilink
// variant).
const LaunchAgentLabel = "tw.caliber.agent"

// LaunchAgentPath returns ~/Library/LaunchAgents/tw.caliber.agent.plist.
func LaunchAgentPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, "Library", "LaunchAgents", LaunchAgentLabel+".plist")
}

// plistTmpl is text/template (not html/template) so we control escaping
// explicitly via xmlEscape below; text/template does NOT auto-escape.
//
// KeepAlive is scoped to SuccessfulExit=false (restart only on a non-zero
// exit / crash) rather than the bare <true/> form (restart on ANY exit).
// run.go exits 0 deliberately on two paths — a revoked device key, and the
// uninstall sentinel — and a bare KeepAlive would relaunch the daemon every
// ~10s after either of those, hammering the server with revoked-key
// requests forever (M2 fix).
var plistTmpl = template.Must(template.New("plist").Parse(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>{{.Label}}</string>
  <key>ProgramArguments</key>
  <array>
    <string>{{.Exec}}</string>
    <string>run</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>{{.Log}}</string>
  <key>StandardErrorPath</key>
  <string>{{.Log}}</string>
</dict>
</plist>
`))

// RenderPlist renders the LaunchAgent plist XML for execPath (the resolved
// caliber-agent binary) and logPath (stdout/stderr sink). execPath and
// logPath are XML-escaped so arbitrary filesystem paths (e.g. containing
// '&') produce valid XML.
func RenderPlist(execPath, logPath string) (string, error) {
	var buf bytes.Buffer
	err := plistTmpl.Execute(&buf, map[string]string{
		"Label": LaunchAgentLabel,
		"Exec":  xmlEscape(execPath),
		"Log":   xmlEscape(logPath),
	})
	return buf.String(), err
}

// xmlEscape escapes s for safe inclusion inside XML character data.
func xmlEscape(s string) string {
	var b bytes.Buffer
	// xml.EscapeText only fails if the underlying writer fails; a
	// bytes.Buffer write never does.
	_ = xml.EscapeText(&b, []byte(s))
	return b.String()
}
