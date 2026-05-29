-- 0016_down.sql — best-effort rollback of 0016_drop_cipher_version.
-- Re-adds the discriminator column with the original default. Note this only
-- restores the schema shape; it cannot recover the per-row v1/v2 values that
-- existed before the column was dropped (all surviving rows were v2 anyway).
ALTER TABLE request_bodies ADD COLUMN IF NOT EXISTS cipher_version smallint NOT NULL DEFAULT 2;
ALTER TABLE credential_vault ADD COLUMN IF NOT EXISTS cipher_version smallint NOT NULL DEFAULT 2;
