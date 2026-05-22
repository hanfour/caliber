package api

import (
	"errors"
	"testing"
)

func TestAPIErrorImplementsErrorAndIsAgainstSentinels(t *testing.T) {
	cases := []struct {
		name       string
		statusCode int
		tag        string
		sentinel   error
	}{
		{"invalid token", 401, "invalid_token", ErrInvalidToken},
		{"token used", 410, "token_already_used", ErrTokenUsed},
		{"token expired", 410, "token_expired", ErrTokenExpired},
		{"server misconf", 500, "server_misconfigured", ErrServerMisconf},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := error(&APIError{StatusCode: tc.statusCode, ErrorTag: tc.tag, Body: "{}"})
			if !errors.Is(err, tc.sentinel) {
				t.Errorf("errors.Is(err, %v) = false", tc.sentinel)
			}
			var apiErr *APIError
			if !errors.As(err, &apiErr) {
				t.Errorf("errors.As did not find *APIError")
			}
		})
	}
}

func TestAPIErrorIsReturnsFalseForUnknownSentinel(t *testing.T) {
	err := &APIError{StatusCode: 400, ErrorTag: "invalid_body"}
	if errors.Is(err, ErrInvalidToken) {
		t.Fatal("status 400 invalid_body should not match ErrInvalidToken")
	}
}

func TestAPIErrorErrorIncludesStatusAndTag(t *testing.T) {
	err := &APIError{StatusCode: 401, ErrorTag: "invalid_token", Body: `{"error":"invalid_token"}`}
	s := err.Error()
	if !contains(s, "401") || !contains(s, "invalid_token") {
		t.Fatalf("Error() = %q, should mention status + tag", s)
	}
}

func contains(haystack, needle string) bool {
	return len(haystack) >= len(needle) && indexOf(haystack, needle) >= 0
}

func indexOf(haystack, needle string) int {
	for i := 0; i+len(needle) <= len(haystack); i++ {
		if haystack[i:i+len(needle)] == needle {
			return i
		}
	}
	return -1
}
