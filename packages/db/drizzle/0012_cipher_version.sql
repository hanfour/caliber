-- HKDF v1 → v2 cipher rotation prep (#121).
--
-- Adds a per-row cipher_version marker so decrypt path can dispatch
-- between old (aide-gateway-*-v1) and new (caliber-gateway-*-v2) HKDF
-- info strings. DEFAULT 1 means every pre-existing row is unambiguously
-- v1 without a backfill UPDATE; postgres 11+ stores this as catalog
-- metadata only (no table rewrite, safe online).

ALTER TABLE "credential_vault"
  ADD COLUMN "cipher_version" SMALLINT NOT NULL DEFAULT 1;

--> statement-breakpoint

ALTER TABLE "request_bodies"
  ADD COLUMN "cipher_version" SMALLINT NOT NULL DEFAULT 1;
