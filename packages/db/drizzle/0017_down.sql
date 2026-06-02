-- 0017_down.sql — best-effort rollback of 0017_mute_tony_stark.
-- Drops the idempotency_records table. All cached idempotency data is lost.
DROP TABLE IF EXISTS "idempotency_records";
