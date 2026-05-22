package api

import (
	"net/http"
	"time"
)

// Client is the thin HTTP client for caliber. PR1 only exposes Enroll;
// later PRs add Ingest. Public fields are settable from tests.
type Client struct {
	BaseURL   string
	HTTP      *http.Client
	UserAgent string
}

// NewClient constructs a Client with a 30s default timeout (spec §4.4).
func NewClient(baseURL, userAgent string) *Client {
	return &Client{
		BaseURL:   baseURL,
		UserAgent: userAgent,
		HTTP:      &http.Client{Timeout: 30 * time.Second},
	}
}
