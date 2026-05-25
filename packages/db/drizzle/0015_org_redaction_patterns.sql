-- 0015_org_redaction_patterns.sql
-- Per-org override for the daemon's secret-scrub regex set. NULL row = use
-- the server-side hardcoded default (mirrors agent/redact/regexes.go).
CREATE TABLE org_redaction_patterns (
  org_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  patterns jsonb NOT NULL,
  updated_at timestamp with time zone NOT NULL DEFAULT NOW()
);
