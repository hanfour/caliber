package watcher

import (
	"bufio"
	"errors"
	"io"
	"os"
	"strings"
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

// Read tails path starting at fromOffset. It is bounded by:
//   - io.LimitReader cap of maxTickBytes+maxLineBytes (≈20 MiB) per call
//   - per-line cap of maxLineBytes (4 MiB) for capped lineBuf storage
//
// lineBufLen (uncapped int64) is the classification key for oversize detection.
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

	openFn := t.Open
	if openFn == nil {
		openFn = func(p string) (io.ReadSeekCloser, error) { return os.Open(p) }
	}
	f, err := openFn(path)
	if err != nil {
		return TailResult{}, err
	}
	defer f.Close()

	if _, err := f.Seek(fromOffset, io.SeekStart); err != nil {
		return TailResult{}, err
	}

	// Hard I/O cap: even adversarial input is bounded to 20 MiB per tick.
	lr := io.LimitReader(f, maxTickBytes+maxLineBytes)
	reader := bufio.NewReaderSize(lr, 64*1024)

	res := TailResult{FromOffset: fromOffset, ToOffset: fromOffset}
	var consumed int64

	// lineBuf is capped at maxLineBytes; used for content storage only.
	// lineBufLen is uncapped; it is the authoritative classification key.
	var lineBuf []byte
	var lineBufLen int64

	// classify is called when a complete line (ending in '\n') is assembled.
	// The trailing '\n' must already be stripped from lineBuf before calling.
	// lineBufLen still includes the '\n' byte.
	classify := func() {
		content := strings.TrimSpace(string(lineBuf))
		// lineBufLen includes the '\n'; subtract 1 for raw content length.
		rawLen := lineBufLen - 1
		if rawLen > int64(maxLineBytes) {
			res.OversizeDropped++
		} else if content == "" {
			res.Skipped++
		} else {
			res.Events = append(res.Events, string(lineBuf))
		}
		res.ToOffset += lineBufLen
		lineBuf = lineBuf[:0]
		lineBufLen = 0
	}

	for {
		slice, err := reader.ReadSlice('\n')
		consumed += int64(len(slice))
		lineBufLen += int64(len(slice))

		// Accumulate into capped lineBuf (storage bound).
		if len(lineBuf) < maxLineBytes {
			room := maxLineBytes - len(lineBuf)
			toCopy := len(slice)
			if toCopy > room {
				toCopy = room
			}
			lineBuf = append(lineBuf, slice[:toCopy]...)
		}

		switch err {
		case nil:
			// Full line read (ends with '\n'). Strip the newline before classify.
			if n := len(lineBuf); n > 0 && lineBuf[n-1] == '\n' {
				lineBuf = lineBuf[:n-1]
			}
			classify()
			if consumed >= maxTickBytes {
				goto done
			}

		case bufio.ErrBufferFull:
			// Internal buffer full mid-line — keep accumulating, do NOT classify.
			continue

		case io.EOF:
			// EOF precedence rules (critical contract):
			//   lineBufLen == 0               → clean end; nothing to do
			//   lineBufLen <= maxLineBytes     → sub-cap incomplete trailing: DROP,
			//                                   do NOT advance ToOffset
			//   lineBufLen > maxLineBytes      → oversize-and-incomplete: DROP content,
			//                                   DO advance ToOffset (forward progress)
			if lineBufLen == 0 {
				goto done
			}
			if lineBufLen <= int64(maxLineBytes) {
				// Incomplete sub-cap trailing line: drop without advancing.
				goto done
			}
			// Oversize-and-incomplete: count the drop and advance for forward progress.
			res.OversizeDropped++
			res.ToOffset += lineBufLen
			goto done

		default:
			return TailResult{}, err
		}
	}

done:
	// TickBudgetHit is unconditional — set regardless of exit path.
	res.TickBudgetHit = consumed >= maxTickBytes
	return res, nil
}

func defaultStat(path string) (int64, error) {
	info, err := os.Stat(path)
	if err != nil {
		return 0, err
	}
	return info.Size(), nil
}
