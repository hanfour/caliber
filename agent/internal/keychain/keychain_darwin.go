//go:build darwin

// Package keychain wraps the macOS `security` CLI for secret storage.
// The wrapper exec's an absolute-path binary (default /usr/bin/security)
// to avoid PATH injection; the binary path is a package-level var so tests
// can inject a fake that records argv.
package keychain

import (
	"bytes"
	"errors"
	"fmt"
	"os/exec"
	"strings"
)

// ServiceName is the macOS keychain "service" identifier for all entries
// written by caliber-agent.
const ServiceName = "tw.caliber.agent"

// SecurityBin is the path to the security(1) binary. Production default is
// /usr/bin/security; tests rewrite this to a fake script. It is a var rather
// than a const specifically to enable that injection.
var SecurityBin = "/usr/bin/security"

// ErrNotFound is returned by Get when the requested keychain item is absent.
var ErrNotFound = errors.New("keychain: not found")

// ErrUnsupported is returned by the non-darwin stub. Declared here too so
// callers can switch on it without build tags.
var ErrUnsupported = errors.New("keychain: not supported on this platform")

// Set writes (or upserts via -U) a generic password to the login keychain
// under ServiceName + account. The secret is never logged.
func Set(account, secret string) error {
	cmd := exec.Command(SecurityBin, "add-generic-password",
		"-U",
		"-s", ServiceName,
		"-a", account,
		"-w", secret,
	)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("keychain: security add-generic-password: %w (stderr: %s)", err, strings.TrimSpace(stderr.String()))
	}
	return nil
}

// Get returns the bare password for ServiceName + account, or ErrNotFound.
func Get(account string) (string, error) {
	cmd := exec.Command(SecurityBin, "find-generic-password",
		"-s", ServiceName,
		"-a", account,
		"-w",
	)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) && exitErr.ExitCode() == 44 {
			return "", ErrNotFound
		}
		return "", fmt.Errorf("keychain: security find-generic-password: %w (stderr: %s)", err, strings.TrimSpace(stderr.String()))
	}
	return strings.TrimRight(stdout.String(), "\n"), nil
}

// Delete removes the entry for ServiceName + account.
func Delete(account string) error {
	cmd := exec.Command(SecurityBin, "delete-generic-password",
		"-s", ServiceName,
		"-a", account,
	)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) && exitErr.ExitCode() == 44 {
			return ErrNotFound
		}
		return fmt.Errorf("keychain: security delete-generic-password: %w (stderr: %s)", err, strings.TrimSpace(stderr.String()))
	}
	return nil
}
