package api

import (
	"errors"
	"fmt"
)

// Sentinel errors callers can match with errors.Is. *APIError.Is below
// fulfils each contract.
var (
	ErrInvalidToken  = errors.New("api: invalid_token")
	ErrTokenUsed     = errors.New("api: token_already_used")
	ErrTokenExpired  = errors.New("api: token_expired")
	ErrServerMisconf = errors.New("api: server misconfigured")
)

// APIError is the only error type the api package returns for HTTP failures.
// It carries the parsed `error` tag from the server response body plus the
// raw body for debugging. The custom Is method lets callers use either
// errors.Is(err, ErrInvalidToken) or errors.As(err, &apiErr) on the same
// returned value (spec §4.4).
type APIError struct {
	StatusCode int
	ErrorTag   string // parsed from JSON `error` field
	Body       string // first 200 chars of raw response body
}

func (e *APIError) Error() string {
	return fmt.Sprintf("api: status %d, tag %q, body: %s", e.StatusCode, e.ErrorTag, e.Body)
}

// Is matches sentinel errors by (StatusCode, ErrorTag) pairs. Spec §4.4.
func (e *APIError) Is(target error) bool {
	switch target {
	case ErrInvalidToken:
		return e.StatusCode == 401 && e.ErrorTag == "invalid_token"
	case ErrTokenUsed:
		return e.StatusCode == 410 && e.ErrorTag == "token_already_used"
	case ErrTokenExpired:
		return e.StatusCode == 410 && e.ErrorTag == "token_expired"
	case ErrServerMisconf:
		return e.StatusCode == 500 && e.ErrorTag == "server_misconfigured"
	}
	return false
}
