package watcher

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestTailer_FileGone_ReturnsErrFileGone(t *testing.T) {
	tt := &Tailer{}
	_, err := tt.Read("/path/that/does/not/exist", 0)
	if !errors.Is(err, ErrFileGone) {
		t.Fatalf("err = %v, want ErrFileGone", err)
	}
}

func TestTailer_FileShrank_ReturnsErrFileShrank(t *testing.T) {
	tmp := t.TempDir()
	path := filepath.Join(tmp, "x.jsonl")
	if err := os.WriteFile(path, []byte("hi"), 0o644); err != nil {
		t.Fatal(err)
	}
	tt := &Tailer{}
	_, err := tt.Read(path, 10000)
	if !errors.Is(err, ErrFileShrank) {
		t.Fatalf("err = %v, want ErrFileShrank", err)
	}
}
