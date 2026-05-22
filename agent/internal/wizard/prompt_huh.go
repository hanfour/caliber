package wizard

import "github.com/charmbracelet/huh"

// StdinPrompter is the production Prompter implementation. It delegates to
// charmbracelet/huh to render forms on the controlling TTY. This file is
// excluded from coverage measurement because the huh.*.Run() calls block on
// a real terminal and cannot be unit-tested.
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

func huhConfirm(question string, def bool, out *bool) error {
	*out = def
	return huh.NewConfirm().Title(question).Value(out).Run()
}

func huhMultiSelect(question string, options []string, out *[]int) error {
	opts := make([]huh.Option[int], len(options))
	for i, label := range options {
		opts[i] = huh.NewOption(label, i)
	}
	return huh.NewMultiSelect[int]().Title(question).Options(opts...).Value(out).Run()
}

func huhInput(question string, out *string) error {
	return huh.NewInput().Title(question).Value(out).Run()
}
