package wizard

import (
	"context"
	"fmt"

	"github.com/hanfour/ai-dev-eval/agent/internal/api"
	"github.com/hanfour/ai-dev-eval/agent/internal/config"
)

// Deps is the dependency bag for RunEnrollWizard. Splitting them out makes
// the wizard trivially testable: production wires real api.Client + keychain
// callbacks; tests pass fakes.
type Deps struct {
	Prompter  Prompter
	Scan      func(root string) ([]ProjectCandidate, error)
	Enroll    func(ctx context.Context, req api.EnrollRequest) (*api.EnrollResponse, error)
	SetSecret func(account, secret string) error

	// Static metadata shipped in the enroll request body.
	Hostname     string
	OS           string
	AgentVersion string

	// Persisted into the new config.toml.
	APIBaseURL         string
	ClaudeProjectsRoot string // typically ~/.claude/projects
}

// LostKeyError is returned by RunEnrollWizard when the server returned a
// device key but the daemon could not persist it. The cli layer detects
// this via errors.As and emits the Failure-C user message (spec §5).
type LostKeyError struct {
	DeviceID string
	RawKey   string
	Cause    error
}

func (e *LostKeyError) Error() string {
	return fmt.Sprintf("api returned device key but local storage failed: %v", e.Cause)
}
func (e *LostKeyError) Unwrap() error { return e.Cause }

// RunEnrollWizard orchestrates the full enroll flow defined in spec §5.
// On success the function returns nil and the config has been written.
// On failure it returns a typed error suitable for cli.ExitFromErr.
func RunEnrollWizard(ctx context.Context, d Deps, token string) error {
	// Step 1: Confirm intent before anything observable happens.
	begin, err := d.Prompter.Confirm("Begin device enrollment with caliber?", true)
	if err != nil {
		return err
	}
	if !begin {
		return fmt.Errorf("enrollment cancelled by user")
	}

	// Step 2: Server credential exchange.
	resp, err := d.Enroll(ctx, api.EnrollRequest{
		Token:        token,
		Hostname:     d.Hostname,
		OS:           d.OS,
		AgentVersion: d.AgentVersion,
	})
	if err != nil {
		return err
	}

	// Step 3: Keychain. Failure here is Failure C — credentials are lost
	// because the API call already succeeded but we can't store them.
	if err := d.SetSecret(resp.DeviceID, resp.Key); err != nil {
		return &LostKeyError{DeviceID: resp.DeviceID, RawKey: resp.Key, Cause: err}
	}

	// Step 4: Initial config.toml with empty IncludePaths (privacy default).
	cfg := &config.Config{
		DeviceID:     resp.DeviceID,
		Hostname:     d.Hostname,
		OS:           d.OS,
		APIBaseURL:   d.APIBaseURL,
		Mode:         "metadata-only",
		IncludePaths: []string{},
	}
	if err := config.Save(cfg); err != nil {
		return fmt.Errorf("config save: %w", err)
	}

	// Step 5: Scan + present candidate paths. Default is "none".
	cands, _ := d.Scan(d.ClaudeProjectsRoot)
	options := make([]string, 0, len(cands)+1)
	options = append(options, "None — start with 0 paths (recommended)")
	for _, c := range cands {
		options = append(options, c.CWD)
	}
	picks, err := d.Prompter.SelectMulti("Which projects should caliber-agent watch?", options)
	if err != nil {
		return err
	}
	include := []string{}
	for _, idx := range picks {
		if idx == 0 {
			// "None" picked; treat as empty regardless of other picks.
			include = []string{}
			break
		}
		if idx-1 < len(cands) {
			include = append(include, cands[idx-1].CWD)
		}
	}

	// Step 6: Final confirm + write.
	confirmed, err := d.Prompter.Confirm(fmt.Sprintf("Save config with %d include_paths?", len(include)), true)
	if err != nil {
		return err
	}
	if !confirmed {
		return nil // wizard ends but keychain + initial config persist
	}
	cfg.IncludePaths = include
	if err := config.Save(cfg); err != nil {
		return fmt.Errorf("config save (paths): %w", err)
	}
	return nil
}
