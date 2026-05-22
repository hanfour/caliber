package watcher

import (
	"errors"
	"io"
	"os"
)

const (
	maxLineBytes = 4 * 1024 * 1024
	maxTickBytes = 16 * 1024 * 1024
)

var (
	ErrFileGone   = errors.New("tail: file gone")
	ErrFileShrank = errors.New("tail: file shrank")
)

// TailResult holds the output of a single Tailer.Read call.
type TailResult struct {
	Events          []string
	FromOffset      int64
	ToOffset        int64
	Skipped         int
	OversizeDropped int
	TickBudgetHit   bool
}

// Tailer reads new-line-delimited events appended to a file since a given byte
// offset. Both Open and Stat are optional; when nil the standard os functions
// are used.
type Tailer struct {
	Open func(path string) (io.ReadSeekCloser, error)
	Stat func(path string) (int64, error)
}

// Read tails path starting at fromOffset.
func (t *Tailer) Read(path string, fromOffset int64) (TailResult, error) {
	stat := t.Stat
	if stat == nil {
		stat = defaultStat
	}
	size, err := stat(path)
	if err != nil {
		if os.IsNotExist(err) {
			return TailResult{}, ErrFileGone
		}
		return TailResult{}, err
	}
	if size < fromOffset {
		return TailResult{}, ErrFileShrank
	}
	if size == fromOffset {
		return TailResult{FromOffset: fromOffset, ToOffset: fromOffset}, nil
	}
	return TailResult{}, errors.New("not implemented")
}

func defaultStat(path string) (int64, error) {
	info, err := os.Stat(path)
	if err != nil {
		return 0, err
	}
	return info.Size(), nil
}
