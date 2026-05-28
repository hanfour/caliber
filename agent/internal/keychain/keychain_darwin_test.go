//go:build darwin

package keychain

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// writeFakeSecurity creates an executable shell script at <dir>/security that
// records its argv to <dir>/argv.log and exits with the given code.
func writeFakeSecurity(t *testing.T, dir string, exitCode int, stdoutLine string) {
	t.Helper()
	script := "#!/bin/sh\n" +
		"echo \"$@\" >> \"" + dir + "/argv.log\"\n"
	if stdoutLine != "" {
		script += "echo \"" + stdoutLine + "\"\n"
	}
	if exitCode != 0 {
		script += "exit " + itoa(exitCode) + "\n"
	}
	path := filepath.Join(dir, "security")
	if err := os.WriteFile(path, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
}

func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	out := ""
	for i > 0 {
		out = string(rune('0'+i%10)) + out
		i /= 10
	}
	return out
}

func TestSetInvokesSecurityWithExpectedArgs(t *testing.T) {
	dir := t.TempDir()
	writeFakeSecurity(t, dir, 0, "")

	orig := SecurityBin
	SecurityBin = filepath.Join(dir, "security")
	t.Cleanup(func() { SecurityBin = orig })

	if err := Set("dev-abc", "cda_secret", ""); err != nil {
		t.Fatalf("Set: %v", err)
	}

	bs, err := os.ReadFile(filepath.Join(dir, "argv.log"))
	if err != nil {
		t.Fatal(err)
	}
	got := string(bs)
	for _, want := range []string{"add-generic-password", "-U", "-s", ServiceName, "-a", "dev-abc", "-w", "cda_secret"} {
		if !strings.Contains(got, want) {
			t.Errorf("argv missing %q in %q", want, got)
		}
	}
}

func TestSetReturnsErrorOnNonZeroExit(t *testing.T) {
	dir := t.TempDir()
	writeFakeSecurity(t, dir, 1, "")
	orig := SecurityBin
	SecurityBin = filepath.Join(dir, "security")
	t.Cleanup(func() { SecurityBin = orig })

	if err := Set("dev-abc", "cda_x", ""); err == nil {
		t.Fatal("expected non-nil error on exit 1")
	}
}

func TestGetReturnsErrNotFoundOnExit44(t *testing.T) {
	dir := t.TempDir()
	writeFakeSecurity(t, dir, 44, "")
	orig := SecurityBin
	SecurityBin = filepath.Join(dir, "security")
	t.Cleanup(func() { SecurityBin = orig })

	_, err := Get("missing", "")
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
}

func TestGetReturnsPasswordFromStdout(t *testing.T) {
	dir := t.TempDir()
	writeFakeSecurity(t, dir, 0, "cda_returned_secret")
	orig := SecurityBin
	SecurityBin = filepath.Join(dir, "security")
	t.Cleanup(func() { SecurityBin = orig })

	got, err := Get("dev-abc", "")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got != "cda_returned_secret" {
		t.Fatalf("Get = %q, want %q", got, "cda_returned_secret")
	}
}

func TestDeleteInvokesSecurityWithExpectedArgs(t *testing.T) {
	dir := t.TempDir()
	writeFakeSecurity(t, dir, 0, "")
	orig := SecurityBin
	SecurityBin = filepath.Join(dir, "security")
	t.Cleanup(func() { SecurityBin = orig })

	if err := Delete("dev-abc", ""); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	bs, _ := os.ReadFile(filepath.Join(dir, "argv.log"))
	got := string(bs)
	for _, want := range []string{"delete-generic-password", "-s", ServiceName, "-a", "dev-abc"} {
		if !strings.Contains(got, want) {
			t.Errorf("argv missing %q in %q", want, got)
		}
	}
}

func TestDeleteReturnsErrNotFoundOnExit44(t *testing.T) {
	dir := t.TempDir()
	writeFakeSecurity(t, dir, 44, "")
	orig := SecurityBin
	SecurityBin = filepath.Join(dir, "security")
	t.Cleanup(func() { SecurityBin = orig })

	if err := Delete("missing", ""); !errors.Is(err, ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
}

// #168: a non-empty keychainPath is appended as the trailing positional
// arg so `security` targets that keychain file instead of the login one.
func TestKeychainPathAppendedAsTrailingArg(t *testing.T) {
	const kc = "/Users/h/.caliber-agent/caliber.keychain-db"
	cases := []struct {
		name string
		call func() error
	}{
		{"Set", func() error { return Set("dev-abc", "cda_secret", kc) }},
		{"Get", func() error { _, e := Get("dev-abc", kc); return e }},
		{"Delete", func() error { return Delete("dev-abc", kc) }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			writeFakeSecurity(t, dir, 0, "")
			orig := SecurityBin
			SecurityBin = filepath.Join(dir, "security")
			t.Cleanup(func() { SecurityBin = orig })

			if err := tc.call(); err != nil {
				t.Fatalf("%s: %v", tc.name, err)
			}
			bs, _ := os.ReadFile(filepath.Join(dir, "argv.log"))
			if !strings.Contains(string(bs), kc) {
				t.Errorf("%s: argv missing keychain path %q in %q", tc.name, kc, string(bs))
			}
		})
	}
}

// Empty keychainPath must NOT append a trailing keychain arg — login
// keychain behavior is preserved (no regression for existing configs).
func TestEmptyKeychainPathOmitsTrailingArg(t *testing.T) {
	dir := t.TempDir()
	writeFakeSecurity(t, dir, 0, "")
	orig := SecurityBin
	SecurityBin = filepath.Join(dir, "security")
	t.Cleanup(func() { SecurityBin = orig })

	if err := Set("dev-abc", "cda_secret", ""); err != nil {
		t.Fatalf("Set: %v", err)
	}
	bs, _ := os.ReadFile(filepath.Join(dir, "argv.log"))
	// The argv should end right after the secret; no ".keychain-db" token.
	if strings.Contains(string(bs), ".keychain-db") {
		t.Errorf("empty path should append nothing; argv = %q", string(bs))
	}
}
