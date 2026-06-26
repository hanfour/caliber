-- Custom data migration: seed claude-opus-4-8 pricing.
--
-- opus-4-8 was missing from model_pricing (0009 only seeded opus-4-7), so all
-- opus-4-8 usage priced at $0 — both the notional-cost estimate AND the actual
-- metered cost (under-billing for anyone routing opus-4-8 through a paid key).
-- Rates mirror claude-opus-4-7: Anthropic Opus pricing is consistent across
-- versions ($15/M input, $75/M output, $18.75/M cache-write-5m, $30/M
-- cache-write-1h, $1.50/M cache-read).
--
-- Idempotent via the (platform, model_id, effective_from) unique index so it is
-- a no-op on instances already patched out-of-band (e.g. the live VPS).
INSERT INTO model_pricing (
  platform, model_id,
  input_per_million_micros, output_per_million_micros,
  cached_5m_per_million_micros, cached_1h_per_million_micros,
  cached_input_per_million_micros, cache_read_per_million_micros,
  effective_from
)
VALUES (
  'anthropic', 'claude-opus-4-8',
  15000000, 75000000,
  18750000, 30000000,
  NULL, 1500000,
  TIMESTAMPTZ '2026-04-28T00:00:00Z'
)
ON CONFLICT (platform, model_id, effective_from) DO NOTHING;
