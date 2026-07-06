package wizard

import "testing"

func TestAutoPrompter(t *testing.T) {
	p := AutoPrompter{}
	ok, err := p.Confirm("proceed?", false)
	if err != nil || !ok {
		t.Fatalf("Confirm = %v, %v; want true, nil", ok, err)
	}
	sel, err := p.SelectMulti("pick", []string{"a", "b", "c"})
	if err != nil || len(sel) != 3 || sel[0] != 0 || sel[2] != 2 {
		t.Fatalf("SelectMulti = %v, %v; want [0 1 2], nil", sel, err)
	}
	line, err := p.InputLine("name")
	if err != nil || line != "" {
		t.Fatalf("InputLine = %q, %v; want \"\", nil", line, err)
	}
}
