package watcher

import (
	"io"

	"github.com/hanfour/ai-dev-eval/agent/internal/cwdresolve"
)

// CWDResolver wraps cwdresolve.ResolveOneClaudeDir for the watcher loop.
// The injectable Open is required because the loop tests want to assert
// the 256 KiB per-dir bound holds under the same byte-counter pattern
// the wizard tests use.
type CWDResolver struct {
	open cwdresolve.Opener
}

// NewCWDResolver constructs a resolver. If open is nil, the package
// default is used (wraps os.Open in io.ReadCloser).
func NewCWDResolver(open func(path string) (io.ReadCloser, error)) *CWDResolver {
	if open == nil {
		return &CWDResolver{open: cwdresolve.DefaultOpener}
	}
	return &CWDResolver{open: cwdresolve.Opener(open)}
}

// ResolveClaude returns the cwd for a Claude project directory.
// Three-state contract — same as cwdresolve.ResolveOneClaudeDir:
//
//	(cwd, nil)  resolved
//	("",  nil)  no I/O error but no usable cwd
//	("",  err)  I/O failure
func (r *CWDResolver) ResolveClaude(claudeProjDir string) (string, error) {
	return cwdresolve.ResolveOneClaudeDir(claudeProjDir, r.open)
}
