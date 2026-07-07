-- down: strip minRatio from platform-default keyword signals, revert to 1.1.0
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
                  WHEN sig->>'type' = 'keyword' THEN sig - 'minRatio'
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
    new_def := jsonb_set(new_def, '{version}', '"1.1.0"'::jsonb);
    UPDATE rubrics SET definition = new_def, version = '1.1.0' WHERE id = r.id;
  END LOOP;
END $$;
