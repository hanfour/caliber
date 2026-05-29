-- 0016_drop_cipher_version.sql
-- Phase 4b cleanup (#129): the HKDF v1 cipher path is gone — all surviving
-- rows are v2, so the cipher_version discriminator column is dead. The v1
-- request_bodies have aged out of the 90-day retention window (the last v1
-- rows were purged / manually removed before this migration). Dropping the
-- column from both ciphered tables.
ALTER TABLE request_bodies DROP COLUMN IF EXISTS cipher_version;
ALTER TABLE credential_vault DROP COLUMN IF EXISTS cipher_version;
