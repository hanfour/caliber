-- #261: add minRatio to every keyword signal in the platform-default rubrics
-- so telemetry-sourced scoring (thousands of turns) no longer auto-hits the
-- "any body contains a term" gate and saturates every section to superior.
-- 0.40 = "at least 40% of a member's turns show the pattern", calibrated
-- against the first pilots' real per-turn distributions. Locale-agnostic:
-- iterates every platform-default rubric and patches its keyword signals.
-- Bumps the recorded rubric version to 1.2.0.

DO $$
DECLARE
  r RECORD;
  new_def jsonb;
BEGIN
  FOR r IN
    SELECT id, definition
    FROM rubrics
    WHERE org_id IS NULL AND api_key_id IS NULL AND is_default = true
  LOOP
    new_def := jsonb_set(
      r.definition,
      '{sections}',
      (
        SELECT jsonb_agg(
          jsonb_set(
            sec,
            '{signals}',
            (
              SELECT jsonb_agg(
                CASE
                  WHEN sig->>'type' = 'keyword'
                    THEN sig || jsonb_build_object('minRatio', 0.40)
                  ELSE sig
                END
              )
              FROM jsonb_array_elements(sec->'signals') sig
            )
          )
        )
        FROM jsonb_array_elements(r.definition->'sections') sec
      )
    );
    new_def := jsonb_set(new_def, '{version}', '"1.2.0"'::jsonb);
    UPDATE rubrics SET definition = new_def, version = '1.2.0' WHERE id = r.id;
  END LOOP;
END $$;
