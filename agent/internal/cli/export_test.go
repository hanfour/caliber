package cli

import (
	"testing"

	"github.com/charmbracelet/huh"
	"github.com/hanfour/ai-dev-eval/agent/internal/wizard"
)

// useFakePrompter is the test-only seam for injecting a FakePrompter into
// the enroll command. testPrompterHook is declared in enroll.go (without
// pulling in the "testing" package); this file provides the test-side
// setter, restricted to _test.go consumers so neither the "testing" package
// nor this helper is linked into the production caliber-agent binary.
func useFakePrompter(t *testing.T, confirms []bool, selections [][]int) {
	t.Helper()
	fp := wizard.NewFakePrompter()
	fp.Answers.Confirms = confirms
	fp.Answers.Selections = selections
	testPrompterHook = fp
	t.Cleanup(func() { testPrompterHook = nil })
}

// useAbortingPrompter installs a Prompter whose first Confirm returns
// huh.ErrUserAborted, simulating Ctrl+C during a wizard prompt. The
// resulting error must propagate through the wizard, through runEnroll's
// ExitFromErr call, and out as exit 130 (spec §5 Failure-D, §8).
func useAbortingPrompter(t *testing.T) {
	t.Helper()
	testPrompterHook = &abortingPrompter{}
	t.Cleanup(func() { testPrompterHook = nil })
}

type abortingPrompter struct{}

func (abortingPrompter) Confirm(_ string, _ bool) (bool, error) {
	return false, huh.ErrUserAborted
}
func (abortingPrompter) SelectMulti(_ string, _ []string) ([]int, error) {
	return nil, huh.ErrUserAborted
}
func (abortingPrompter) InputLine(_ string) (string, error) {
	return "", huh.ErrUserAborted
}
