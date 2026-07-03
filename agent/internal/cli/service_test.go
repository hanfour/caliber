package cli

import "testing"

// TestServiceCommandsRegistered guards against install-service /
// uninstall-service silently disappearing from the root command (task 8).
// It only checks registration + Use string via the cobra command tree — it
// must NOT invoke RunE, since on darwin that would shell out to the real
// launchctl and mutate the dev machine's LaunchAgents.
//
// This file carries no build tag on purpose: install-service /
// uninstall-service are wired into the root command by the build-tag-free
// root.go on every platform (only the RunE bodies differ, via
// service_darwin.go / service_other.go), so this registration check must
// compile and run under every GOOS. Platform-specific behavior (the darwin
// plist/launchctl flow and the !darwin ExitNotImplemented stubs) lives in
// service_darwin_test.go and service_other_test.go respectively.
func TestServiceCommandsRegistered(t *testing.T) {
	cmd := New()
	want := map[string]bool{"install-service": false, "uninstall-service": false}
	for _, sub := range cmd.Commands() {
		if _, ok := want[sub.Name()]; ok {
			want[sub.Name()] = true
		}
	}
	for name, found := range want {
		if !found {
			t.Errorf("subcommand %q not registered on root", name)
		}
	}
}
