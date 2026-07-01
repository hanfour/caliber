-- down: rubrics.api_key_id key-scope rollback
ALTER TABLE rubrics DROP CONSTRAINT IF EXISTS rubrics_key_scope_chk;
DROP INDEX IF EXISTS rubrics_api_key_uniq;
ALTER TABLE rubrics DROP CONSTRAINT IF EXISTS rubrics_api_key_id_api_keys_id_fk;
ALTER TABLE rubrics DROP COLUMN IF EXISTS api_key_id;
