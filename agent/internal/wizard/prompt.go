package wizard

import "fmt"

// Prompter is the interface exposed to the enroll wizard. The stdin
// implementation uses charmbracelet/huh; tests inject FakePrompter to feed
// scripted answers without touching the real terminal.
type Prompter interface {
	Confirm(question string, def bool) (bool, error)
	SelectMulti(question string, options []string) ([]int, error)
	InputLine(question string) (string, error)
}

// FakePrompter consumes pre-scripted answers in order. Used by tests.
type FakePrompter struct {
	Answers struct {
		Confirms   []bool
		Selections [][]int
		Inputs     []string
	}
	confirmIdx int
	selectIdx  int
	inputIdx   int
}

func NewFakePrompter() *FakePrompter { return &FakePrompter{} }

func (p *FakePrompter) Confirm(_ string, _ bool) (bool, error) {
	if p.confirmIdx >= len(p.Answers.Confirms) {
		return false, fmt.Errorf("FakePrompter: Confirm answers exhausted (idx=%d)", p.confirmIdx)
	}
	v := p.Answers.Confirms[p.confirmIdx]
	p.confirmIdx++
	return v, nil
}

func (p *FakePrompter) SelectMulti(_ string, _ []string) ([]int, error) {
	if p.selectIdx >= len(p.Answers.Selections) {
		return nil, fmt.Errorf("FakePrompter: SelectMulti answers exhausted (idx=%d)", p.selectIdx)
	}
	v := p.Answers.Selections[p.selectIdx]
	p.selectIdx++
	return v, nil
}

func (p *FakePrompter) InputLine(_ string) (string, error) {
	if p.inputIdx >= len(p.Answers.Inputs) {
		return "", fmt.Errorf("FakePrompter: InputLine answers exhausted (idx=%d)", p.inputIdx)
	}
	v := p.Answers.Inputs[p.inputIdx]
	p.inputIdx++
	return v, nil
}

// StdinPrompter wraps huh. Real interactive flow.
type StdinPrompter struct{}

func NewStdinPrompter() *StdinPrompter { return &StdinPrompter{} }

func (StdinPrompter) Confirm(question string, def bool) (bool, error) {
	out := def
	if err := huhConfirm(question, def, &out); err != nil {
		return def, err
	}
	return out, nil
}

func (StdinPrompter) SelectMulti(question string, options []string) ([]int, error) {
	var selected []int
	if err := huhMultiSelect(question, options, &selected); err != nil {
		return nil, err
	}
	return selected, nil
}

func (StdinPrompter) InputLine(question string) (string, error) {
	var out string
	if err := huhInput(question, &out); err != nil {
		return "", err
	}
	return out, nil
}
