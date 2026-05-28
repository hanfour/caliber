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

// withKeychain appends an optional keychain-file positional arg to a
// security(1) argv. The `security` subcommands accept the target keychain
// as a trailing positional; when keychainPath is empty we omit it so the
// login keychain / default search list is used (unchanged behavior). A
// non-empty path targets a dedicated keychain the operator unlocked once
// with `security unlock-keychain`, which is what makes SSH/headless runs
// work (#168).
func withKeychain(args []string, keychainPath string) []string {
	if keychainPath != "" {
		return append(args, keychainPath)
	}
	return args
}

// Set writes (or upserts via -U) a generic password under ServiceName +
// account. keychainPath selects the target keychain file ("" = login).
// The secret is never logged.
func Set(account, secret, keychainPath string) error {
	args := withKeychain([]string{
		"add-generic-password",
		"-U",
		"-s", ServiceName,
		"-a", account,
		"-w", secret,
	}, keychainPath)
	cmd := exec.Command(SecurityBin, args...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("keychain: security add-generic-password: %w (stderr: %s)", err, strings.TrimSpace(stderr.String()))
	}
	return nil
}

// Get returns the bare password for ServiceName + account, or ErrNotFound.
// keychainPath selects the target keychain file ("" = login).
func Get(account, keychainPath string) (string, error) {
	args := withKeychain([]string{
		"find-generic-password",
		"-s", ServiceName,
		"-a", account,
		"-w",
	}, keychainPath)
	cmd := exec.Command(SecurityBin, args...)
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

// Delete removes the entry for ServiceName + account. keychainPath selects
// the target keychain file ("" = login).
func Delete(account, keychainPath string) error {
	args := withKeychain([]string{
		"delete-generic-password",
		"-s", ServiceName,
		"-a", account,
	}, keychainPath)
	cmd := exec.Command(SecurityBin, args...)
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
