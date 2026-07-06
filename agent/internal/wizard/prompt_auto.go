package wizard

// AutoPrompter answers every prompt non-interactively for `caliber login`:
// confirmations pass, multi-selects choose everything, free text is empty.
type AutoPrompter struct{}

func (AutoPrompter) Confirm(_ string, _ bool) (bool, error) { return true, nil }

func (AutoPrompter) SelectMulti(_ string, opts []string) ([]int, error) {
	idx := make([]int, len(opts))
	for i := range opts {
		idx[i] = i
	}
	return idx, nil
}

func (AutoPrompter) InputLine(_ string) (string, error) { return "", nil }
