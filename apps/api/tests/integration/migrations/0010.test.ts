// apps/api/tests/integration/migrations/0010.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { setupTestDb, type TestDb } from "../../factories/db.js";
import { withUsageLogsScoredDropped } from "../../factories/usageLogsScoredView.js";

// Plan 5A migration 0010 — additive extension of usage_logs:
//   * cache_creation_5m_tokens / cache_creation_1h_tokens (Anthropic split)
//   * cached_input_tokens (OpenAI cached_input)
//   * cached_input_cost numeric(20, 10) (OpenAI cached_input cost)
//   * actual_cost_usd numeric(20, 10) (second-stage billing — aligned with
//     total_cost precision so multiplier-applied values never lose digits)
//   * group_id (FK accountGroups ON DELETE SET NULL)
//   * usage_logs_group_time_idx
//
// Pre-existing 4A/4C rows are preserved; the new columns default to 0 / NULL
// so historical reporting paths read sensible values without backfill.

describe("migration 0010 usage_logs extension", () => {
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await setupTestDb();
  });

  afterAll(async () => {
    await testDb.stop();
  });

  it("adds the 6 new usage_logs columns with the documented types + defaults", async () => {
    const cols = await testDb.db.execute<{
      column_name: string;
      data_type: string;
      column_default: string | null;
      is_nullable: string;
    }>(sql`
      SELECT column_name, data_type, column_default, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'usage_logs' AND column_name IN (
        'cache_creation_5m_tokens',
        'cache_creation_1h_tokens',
        'cached_input_tokens',
        'cached_input_cost',
        'actual_cost_usd',
        'group_id'
      )
      ORDER BY column_name
    `);
    const byName = Object.fromEntries(cols.rows.map((r) => [r.column_name, r]));

    expect(byName.cache_creation_5m_tokens?.data_type).toBe("integer");
    expect(byName.cache_creation_5m_tokens?.column_default).toBe("0");
    expect(byName.cache_creation_5m_tokens?.is_nullable).toBe("NO");

    expect(byName.cache_creation_1h_tokens?.data_type).toBe("integer");
    expect(byName.cache_creation_1h_tokens?.is_nullable).toBe("NO");

    expect(byName.cached_input_tokens?.data_type).toBe("integer");
    expect(byName.cached_input_tokens?.is_nullable).toBe("NO");

    expect(byName.cached_input_cost?.data_type).toBe("numeric");
    expect(byName.cached_input_cost?.is_nullable).toBe("NO");

    expect(byName.actual_cost_usd?.data_type).toBe("numeric");
    expect(byName.actual_cost_usd?.is_nullable).toBe("NO");

    // group_id is nullable (legacy rows + unbound api-keys have NULL).
    expect(byName.group_id?.data_type).toBe("uuid");
    expect(byName.group_id?.is_nullable).toBe("YES");
  });

  it("creates usage_logs_group_time_idx on (group_id, created_at)", async () => {
    const idx = await testDb.db.execute<{ indexname: string }>(sql`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'usage_logs'
      ORDER BY indexname
    `);
    const names = idx.rows.map((r) => r.indexname);
    expect(names).toContain("usage_logs_group_time_idx");
    // Confirm it's an index over the right columns by inspecting the
    // index definition (quote-wrapped column names from pg_get_indexdef).
    const def = await testDb.db.execute<{ pg_get_indexdef: string }>(sql`
      SELECT pg_get_indexdef(c.oid) FROM pg_class c
      WHERE c.relname = 'usage_logs_group_time_idx'
    `);
    expect(def.rows[0]?.pg_get_indexdef).toMatch(/group_id/);
    expect(def.rows[0]?.pg_get_indexdef).toMatch(/created_at/);
  });

  it("group_id FK uses ON DELETE SET NULL (preserves historical rows)", async () => {
    const fk = await testDb.db.execute<{ delete_rule: string }>(sql`
      SELECT rc.delete_rule
      FROM information_schema.referential_constraints rc
      JOIN information_schema.table_constraints tc
        ON tc.constraint_name = rc.constraint_name
      WHERE tc.table_name = 'usage_logs'
        AND rc.constraint_name = 'usage_logs_group_id_account_groups_id_fk'
    `);
    expect(fk.rows.length).toBe(1);
    expect(fk.rows[0]!.delete_rule).toBe("SET NULL");
  });

  it("0010_down.sql reverses the schema cleanly without losing 4A rows", async () => {
    // Run down on a SECOND testDb so the main testDb stays usable. Down
    // SQL mirrors packages/db/drizzle/0010_down.sql verbatim.
    const downDb = await setupTestDb();
    try {
      // Seed one minimal 4A-shaped row to confirm pre-existing data
      // survives.  The row uses the legacy usage_logs columns only — no
      // new fields — and a real org/user/api_key/account chain.
      const orgId = (await downDb.db.execute<{ id: string }>(sql`
        INSERT INTO organizations (slug, name) VALUES ('o-pre0010', 'org')
        RETURNING id
      `)).rows[0]!.id;
      const userId = (await downDb.db.execute<{ id: string }>(sql`
        INSERT INTO users (email, name) VALUES ('pre0010@t.test', 'u')
        RETURNING id
      `)).rows[0]!.id;
      const apiKeyId = (await downDb.db.execute<{ id: string }>(sql`
        INSERT INTO api_keys (user_id, org_id, key_hash, key_prefix, name)
        VALUES (${userId}, ${orgId}, 'h', 'ak_t', 'k')
        RETURNING id
      `)).rows[0]!.id;
      const accountId = (await downDb.db.execute<{ id: string }>(sql`
        INSERT INTO upstream_accounts (org_id, name, platform, type)
        VALUES (${orgId}, 'a', 'anthropic', 'oauth')
        RETURNING id
      `)).rows[0]!.id;
      await downDb.db.execute(sql`
        INSERT INTO usage_logs (
          request_id, user_id, api_key_id, account_id, org_id,
          requested_model, upstream_model, platform, surface,
          status_code, duration_ms
        ) VALUES (
          'req-pre-0010', ${userId}, ${apiKeyId}, ${accountId}, ${orgId},
          'claude-x', 'claude-x', 'anthropic', 'messages', 200, 100
        )
      `);

      // Apply 0010_down. The withUsageLogsScoredDropped wrapper models the
      // 0034_down step that a real newest-first rollback would already have
      // run: 0034's `SELECT *` view pins every usage_logs column against
      // DROP COLUMN. Do NOT remove — without it these DROP COLUMNs fail
      // with 2BP01.
      await withUsageLogsScoredDropped(downDb, () =>
        downDb.db.execute(sql`
          DROP INDEX IF EXISTS usage_logs_group_time_idx;
          ALTER TABLE usage_logs
            DROP CONSTRAINT IF EXISTS usage_logs_group_id_account_groups_id_fk;
          ALTER TABLE usage_logs
            DROP COLUMN IF EXISTS group_id,
            DROP COLUMN IF EXISTS actual_cost_usd,
            DROP COLUMN IF EXISTS cached_input_cost,
            DROP COLUMN IF EXISTS cached_input_tokens,
            DROP COLUMN IF EXISTS cache_creation_1h_tokens,
            DROP COLUMN IF EXISTS cache_creation_5m_tokens;
        `),
      );

      // The seeded row still exists and is readable via the original
      // 4A column set.
      const after = await downDb.db.execute<{
        request_id: string;
        upstream_model: string;
        total_cost: string;
      }>(sql`
        SELECT request_id, upstream_model, total_cost
        FROM usage_logs WHERE request_id = 'req-pre-0010'
      `);
      expect(after.rows.length).toBe(1);
      expect(after.rows[0]!.upstream_model).toBe("claude-x");

      // The 6 new columns are gone.
      const remaining = await downDb.db.execute<{ exists: boolean }>(sql`
        SELECT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'usage_logs' AND column_name IN (
            'cache_creation_5m_tokens',
            'cache_creation_1h_tokens',
            'cached_input_tokens',
            'cached_input_cost',
            'actual_cost_usd',
            'group_id'
          )
        ) AS exists
      `);
      expect(remaining.rows[0]!.exists).toBe(false);
    } finally {
      await downDb.stop();
    }
  });
});
