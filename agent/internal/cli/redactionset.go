package cli

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/hanfour/ai-dev-eval/agent/internal/api"
	"github.com/hanfour/ai-dev-eval/agent/internal/config"
	"github.com/hanfour/ai-dev-eval/agent/redact"
)

// Logger is the minimal logging contract used by the cli package. Both
// config.RFCLogger and watcher.Logger satisfy this interface.
type Logger interface {
	Printf(format string, args ...any)
}

// RedactionSetProvider is what watcher.Chunker reads from. Embedded
// pointer + RWMutex for safe Set/Current across the daemon's main
// goroutine and the refresher goroutine.
type RedactionSetProvider struct {
	mu      sync.RWMutex
	current *redact.RedactionSet
}

func (p *RedactionSetProvider) Current() *redact.RedactionSet {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return p.current
}

func (p *RedactionSetProvider) Set(s *redact.RedactionSet) {
	p.mu.Lock()
	p.current = s
	p.mu.Unlock()
}

// BootstrapRedactionSet handles the startup three-tier fallback:
//
//  1. cached, not expired       -> use as-is
//  2. cached expired or absent  -> fetch fresh
//  3. fetch fails               -> stale cache (if any) or DefaultSet()
//
// Fatal errors (ErrInvalidToken / ErrKeyRevoked) propagate so the
// daemon can exit cleanly per the PR3 spec §6.4 fatal-vs-recoverable
// boundary. All other fetch failures degrade gracefully.
func BootstrapRedactionSet(ctx context.Context, client *api.Client, token string, logger Logger) (*RedactionSetProvider, error) {
	prov := &RedactionSetProvider{}

	cached, cerr := config.LoadRedactionSet()
	hasCache := cerr == nil

	now := time.Now().UTC()
	if hasCache && !cached.IsExpired(now) {
		_ = cached.Compile()
		prov.Set(cached)
		return prov, nil
	}

	fresh, ferr := client.FetchRedactionSet(ctx, token)
	if ferr != nil {
		if errors.Is(ferr, api.ErrInvalidToken) || errors.Is(ferr, api.ErrKeyRevoked) {
			return nil, ferr
		}
		if hasCache {
			age := now.Sub(cached.FetchedAt)
			logger.Printf("[warn] redaction-set fetch failed, using stale cache (age=%s err=%v)", age, ferr)
			_ = cached.Compile()
			prov.Set(cached)
			return prov, nil
		}
		logger.Printf("[warn] redaction-set fetch failed, using bundled default (err=%v)", ferr)
		prov.Set(redact.DefaultSet())
		return prov, nil
	}

	set := &redact.RedactionSet{
		Patterns:   fresh.Patterns,
		Version:    fresh.Version,
		FetchedAt:  now,
		TTLSeconds: fresh.TTLSeconds,
	}
	if err := set.Compile(); err != nil {
		// ErrTooManyPatterns is a hard rejection — the fetched set is unsafe
		// (all Regex fields are nil so ScrubString would no-op, leaking
		// secrets). Fall back to the stale cache if we have one, otherwise
		// the bundled default. Do NOT persist the rejected set.
		if errors.Is(err, redact.ErrTooManyPatterns) {
			logger.Printf("[error] fresh redaction-set rejected: %v; falling back", err)
			if hasCache {
				_ = cached.Compile()
				prov.Set(cached)
				return prov, nil
			}
			prov.Set(redact.DefaultSet())
			return prov, nil
		}
		logger.Printf("[warn] %v", err) // per-pattern errors — set still usable
	}
	prov.Set(set)
	_ = config.SaveRedactionSet(set)
	logger.Printf("[refresh] redaction-set version=%s patterns=%d ttl=%ds", set.Version, len(set.Patterns), set.TTLSeconds)
	return prov, nil
}
