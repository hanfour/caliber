package wizard

import "github.com/charmbracelet/huh"

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
