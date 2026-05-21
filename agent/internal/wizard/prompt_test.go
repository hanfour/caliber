package wizard

import "testing"

func TestFakePrompterConfirmDefault(t *testing.T) {
	fp := NewFakePrompter()
	fp.Answers.Confirms = []bool{true}
	got, err := fp.Confirm("question?", false)
	if err != nil {
		t.Fatal(err)
	}
	if !got {
		t.Errorf("Confirm returned false, want true (from scripted answer)")
	}
}

func TestFakePrompterSelectMulti(t *testing.T) {
	fp := NewFakePrompter()
	fp.Answers.Selections = [][]int{{0, 2}}
	got, err := fp.SelectMulti("pick", []string{"a", "b", "c"})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0] != 0 || got[1] != 2 {
		t.Errorf("selections = %v, want [0,2]", got)
	}
}

func TestFakePrompterExhaustedReturnsError(t *testing.T) {
	fp := NewFakePrompter()
	if _, err := fp.Confirm("q", false); err == nil {
		t.Fatal("expected error when answers exhausted")
	}
}
