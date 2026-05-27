package cli

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"time"

	"github.com/spf13/cobra"

	"github.com/hanfour/ai-dev-eval/agent/internal/config"
	"github.com/hanfour/ai-dev-eval/agent/internal/version"
)

// newStatusCmd wires `caliber-agent status [--json]`. Spec §3.5.
//
// Behaviour summary:
//   - ZERO network IO. Reads config.toml + state.json + a single stat for
//     the paused sentinel; nothing else. This invariant is asserted by
//     TestStatus_DoesNotMakeNetworkRequests in status_test.go.
//   - Exits 1 if not enrolled (config.Load returns ErrNotEnrolled).
//   - human output: version / device_id / api_base_url (+ insecure badge) /
//     mode / paused / watched paths / files tracked / last sync.
//   - --json output: same fields with stable wire keys (snake_case).
func newStatusCmd() *cobra.Command {
	var jsonOut bool
	cmd := &cobra.Command{
		Use:   "status",
		Short: "Show daemon status (local read; zero network IO)",
		RunE: func(cmd *cobra.Command, _ []string) error {
			return runStatus(cmd, jsonOut)
		},
	}
	cmd.Flags().BoolVar(&jsonOut, "json", false, "machine-readable JSON output")
	return cmd
}

// statusPayload is the on-wire JSON shape for `status --json`. Field names
// are snake_case to match spec §3.5.
type statusPayload struct {
	Version           string   `json:"version"`
	DeviceID          string   `json:"device_id"`
	APIBaseURL        string   `json:"api_base_url"`
	InsecureTransport bool     `json:"insecure_transport"`
	Mode              string   `json:"mode"`
	Paused            bool     `json:"paused"`
	WatchedPaths      []string `json:"watched_paths"`
	FilesTracked      int      `json:"files_tracked"`
	LastSync          string   `json:"last_sync,omitempty"`
}

func runStatus(cmd *cobra.Command, jsonOut bool) error {
	cfg, err := config.Load()
	if err != nil {
		return &ExitError{Code: 1, Err: err}
	}
	// State is optional — a fresh enrollment has no state.json yet. Treat any
	// load error as "nothing tracked" rather than failing status.
	state, _ := config.LoadState()
	if state == nil {
		state = &config.State{Files: map[string]config.FileWatermark{}}
	}

	// Paused sentinel check (single stat, no network IO).
	paused := false
	if _, err := os.Stat(config.PausedPath()); err == nil {
		paused = true
	} else if !errors.Is(err, fs.ErrNotExist) {
		// Treat unknown stat error as not-paused for display. We deliberately
		// don't fail the whole command on an unexpected stat error — status
		// is informational and should keep printing what it can.
		paused = false
	}

	watched := cfg.IncludePaths
	if watched == nil {
		watched = []string{}
	}

	// Compute last_sync as the max LastSync across all FileWatermarks.
	// ISO 8601 UTC with Z suffix (spec §3.5 example: 2026-05-25T08:32:11Z).
	var maxSync time.Time
	for _, w := range state.Files {
		if w.LastSync.After(maxSync) {
			maxSync = w.LastSync
		}
	}
	lastSync := ""
	if !maxSync.IsZero() {
		lastSync = maxSync.UTC().Format("2006-01-02T15:04:05Z")
	}

	p := statusPayload{
		Version:           version.Version,
		DeviceID:          cfg.DeviceID,
		APIBaseURL:        cfg.APIBaseURL,
		InsecureTransport: cfg.InsecureTransport,
		Mode:              cfg.Mode,
		Paused:            paused,
		WatchedPaths:      watched,
		FilesTracked:      len(state.Files),
		LastSync:          lastSync,
	}

	if jsonOut {
		enc := json.NewEncoder(cmd.OutOrStdout())
		enc.SetIndent("", "  ")
		if err := enc.Encode(p); err != nil {
			return &ExitError{Code: 1, Err: fmt.Errorf("encode status: %w", err)}
		}
		return nil
	}

	out := cmd.OutOrStdout()
	fmt.Fprintf(out, "caliber-agent %s\n", p.Version)
	fmt.Fprintf(out, "device_id:    %s\n", p.DeviceID)
	fmt.Fprintf(out, "api_base_url: %s%s\n", p.APIBaseURL, insecureBadge(p.InsecureTransport))
	fmt.Fprintf(out, "mode:         %s\n", p.Mode)
	fmt.Fprintf(out, "paused:       %s\n", yesno(p.Paused))
	fmt.Fprintf(out, "watched paths (%d):\n", len(p.WatchedPaths))
	for _, pp := range p.WatchedPaths {
		fmt.Fprintf(out, "  - %s\n", pp)
	}
	if p.LastSync != "" {
		fmt.Fprintf(out, "state:        %d files tracked, last sync %s\n", p.FilesTracked, p.LastSync)
	} else {
		fmt.Fprintf(out, "state:        %d files tracked\n", p.FilesTracked)
	}
	return nil
}

// yesno renders a bool as "yes" / "no" for the human-readable status view.
func yesno(b bool) string {
	if b {
		return "yes"
	}
	return "no"
}

// insecureBadge appends a " (insecure)" tag to api_base_url when the daemon
// is configured with insecure_transport = true (http:// allowed via the
// enroll --insecure flag, dev/local only).
func insecureBadge(b bool) string {
	if b {
		return " (insecure)"
	}
	return ""
}
