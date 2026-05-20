// apps/api/tests/integration/migrations/0008.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import {
  apiKeys,
  upstreamAccounts,
  accountGroups,
  accountGroupMembers,
} from "@caliber/db";
import { setupTestDb, type TestDb } from "../../factories/db.js";
import { makeOrg } from "../../factories/org.js";
import { makeUser } from "../../factories/user.js";

// Plan 5A migration 0008:
//   * NEW account_groups + account_group_members tables (with platform/status
//     CHECK, (org_id, name) UNIQUE, partial idx WHERE deleted_at IS NULL).
//   * api_keys.group_id (nullable FK ON DELETE SET NULL, partial idx
//     WHERE revoked_at IS NULL — matches existing api_keys soft-delete column).
//   * upstream_accounts.subscription_tier (text + CHECK).
//   * Backfill DO $$ — per-org legacy-anthropic group + members + unassigned
//     api_keys assignment.
//
// setupTestDb() applies migrate() against a clean container, so the backfill
// DO block executes against an empty upstream_accounts table (no-op). Tests
// that exercise backfill behaviour re-run the SQL below against post-migration
// seed data — this validates the SQL logic rather than the migrator.
//
// The "down migration reverses cleanly" test uses a SECOND testcontainer so
// it does not corrupt the schema state shared by the other tests.
//
// IMPORTANT: this is NOT byte-identical to the migration's backfill block. It
// adds two `ON CONFLICT … DO NOTHING` guards (marked TEST ONLY below) so
// successive test cases inside the same testDb don't trip the (org_id, name)
// UNIQUE constraint when the loop revisits orgs from prior cases. The actual
// migration runs exactly once per environment, so it has no ON CONFLICT —
// adding it there would mask half-applied state.

const BACKFILL_SQL_TEST_VARIANT = sql`
  DO $$
  DECLARE
    v_org_id UUID;
    v_group_id UUID;
  BEGIN
    FOR v_org_id IN
      SELECT DISTINCT org_id FROM upstream_accounts
      WHERE platform = 'anthropic' AND deleted_at IS NULL
    LOOP
      INSERT INTO account_groups (org_id, name, platform, description)
      VALUES (
        v_org_id,
        'legacy-anthropic',
        'anthropic',
        'Auto-created during 5A migration; reorganise in admin UI'
      )
      ON CONFLICT (org_id, name) DO NOTHING -- TEST ONLY: not in migration
      RETURNING id INTO v_group_id;

      IF v_group_id IS NULL THEN
        SELECT id INTO v_group_id FROM account_groups
        WHERE org_id = v_org_id AND name = 'legacy-anthropic';
      END IF;

      INSERT INTO account_group_members (account_id, group_id, priority)
      SELECT id, v_group_id, priority
      FROM upstream_accounts
      WHERE org_id = v_org_id AND platform = 'anthropic' AND deleted_at IS NULL
      ON CONFLICT (account_id, group_id) DO NOTHING -- TEST ONLY: not in migration
      ;

      UPDATE api_keys SET group_id = v_group_id
      WHERE org_id = v_org_id AND group_id IS NULL AND revoked_at IS NULL;
    END LOOP;
  END $$;
`;

describe("migration 0008 account_groups + group_id + subscription_tier", () => {
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await setupTestDb();
  });

  afterAll(async () => {
    await testDb.stop();
  });

  it("account_groups table exists with the expected columns", async () => {
    const result = await testDb.db.execute<{ column_name: string }>(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'account_groups'
      ORDER BY ordinal_position
    `);
    expect(result.rows.map((r) => r.column_name)).toEqual([
      "id",
      "org_id",
      "name",
      "description",
      "platform",
      "rate_multiplier",
      "is_exclusive",
      "status",
      "created_at",
      "updated_at",
      "deleted_at",
    ]);
  });

  it("account_group_members has composite PK on (account_id, group_id)", async () => {
    const result = await testDb.db.execute<{ column_name: string }>(sql`
      SELECT a.attname AS column_name
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indrelid
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(i.indkey)
      WHERE c.relname = 'account_group_members' AND i.indisprimary
      ORDER BY array_position(i.indkey, a.attnum)
    `);
    expect(result.rows.map((r) => r.column_name)).toEqual([
      "account_id",
      "group_id",
    ]);
  });

  it("api_keys.group_id column exists, is nullable, and references account_groups with ON DELETE SET NULL", async () => {
    const col = await testDb.db.execute<{
      column_name: string;
      is_nullable: string;
      data_type: string;
    }>(sql`
      SELECT column_name, is_nullable, data_type
      FROM information_schema.columns
      WHERE table_name = 'api_keys' AND column_name = 'group_id'
    `);
    expect(col.rows.length).toBe(1);
    expect(col.rows[0]!.is_nullable).toBe("YES");
    expect(col.rows[0]!.data_type).toBe("uuid");

    const fk = await testDb.db.execute<{ delete_rule: string }>(sql`
      SELECT rc.delete_rule
      FROM information_schema.referential_constraints rc
      JOIN information_schema.table_constraints tc
        ON tc.constraint_name = rc.constraint_name
      WHERE tc.table_name = 'api_keys'
        AND rc.constraint_name = 'api_keys_group_id_account_groups_id_fk'
    `);
    expect(fk.rows.length).toBe(1);
    expect(fk.rows[0]!.delete_rule).toBe("SET NULL");
  });

  it("subscription_tier CHECK rejects invalid values", async () => {
    const org = await makeOrg(testDb.db);
    await expect(
      testDb.pool.query(
        `INSERT INTO upstream_accounts (id, org_id, name, platform, type, subscription_tier)
         VALUES (gen_random_uuid(), $1, 'test', 'openai', 'oauth', 'invalid')`,
        [org.id],
      ),
    ).rejects.toThrow(/subscription_tier_values/);
  });

  it("subscription_tier CHECK accepts NULL and the documented tiers", async () => {
    const org = await makeOrg(testDb.db);
    for (const tier of [null, "free", "plus", "pro", "team", "enterprise"]) {
      await testDb.pool.query(
        `INSERT INTO upstream_accounts (id, org_id, name, platform, type, subscription_tier)
         VALUES (gen_random_uuid(), $1, $2, 'openai', 'oauth', $3)`,
        [org.id, `acct-${tier ?? "null"}-${Date.now()}`, tier],
      );
    }
  });

  it("account_groups platform CHECK accepts anthropic|openai|gemini|antigravity", async () => {
    const org = await makeOrg(testDb.db);
    for (const platform of ["anthropic", "openai", "gemini", "antigravity"]) {
      await testDb.db.insert(accountGroups).values({
        orgId: org.id,
        name: `${platform}-${Date.now()}`,
        platform,
      });
    }
  });

  it("account_groups platform CHECK rejects other values", async () => {
    const org = await makeOrg(testDb.db);
    await expect(
      testDb.db.insert(accountGroups).values({
        orgId: org.id,
        name: `bad-${Date.now()}`,
        platform: "bedrock",
      }),
    ).rejects.toMatchObject({
      cause: { code: "23514", constraint: "account_groups_platform_values" },
    });
  });

  it("backfill creates one legacy-anthropic group per org and adds existing anthropic accounts as members", async () => {
    const org = await makeOrg(testDb.db);
    const [a1] = await testDb.db
      .insert(upstreamAccounts)
      .values({
        orgId: org.id,
        name: `seed-acct-1-${Date.now()}`,
        platform: "anthropic",
        type: "oauth",
        priority: 30,
      })
      .returning({ id: upstreamAccounts.id });
    const [a2] = await testDb.db
      .insert(upstreamAccounts)
      .values({
        orgId: org.id,
        name: `seed-acct-2-${Date.now()}`,
        platform: "anthropic",
        type: "api_key",
        priority: 70,
      })
      .returning({ id: upstreamAccounts.id });

    await testDb.db.execute(BACKFILL_SQL_TEST_VARIANT);

    const groups = await testDb.db.execute<{
      id: string;
      name: string;
      platform: string;
    }>(sql`
      SELECT id, name, platform FROM account_groups
      WHERE org_id = ${org.id}
    `);
    expect(groups.rows.length).toBe(1);
    expect(groups.rows[0]!.name).toBe("legacy-anthropic");
    expect(groups.rows[0]!.platform).toBe("anthropic");

    const members = await testDb.db.execute<{
      account_id: string;
      priority: number;
    }>(sql`
      SELECT account_id, priority FROM account_group_members
      WHERE group_id = ${groups.rows[0]!.id}
      ORDER BY priority
    `);
    expect(members.rows.map((r) => r.account_id).sort()).toEqual(
      [a1!.id, a2!.id].sort(),
    );
    expect(members.rows.map((r) => r.priority)).toEqual([30, 70]);
  });

  it("backfill assigns existing unassigned api_keys to the org's legacy-anthropic group", async () => {
    const org = await makeOrg(testDb.db);
    const user = await makeUser(testDb.db, { orgId: org.id });
    await testDb.db.insert(upstreamAccounts).values({
      orgId: org.id,
      name: `acct-${Date.now()}`,
      platform: "anthropic",
      type: "oauth",
    });
    const [key] = await testDb.db
      .insert(apiKeys)
      .values({
        userId: user.id,
        orgId: org.id,
        keyHash: `h-${Date.now()}`,
        keyPrefix: "ak_t",
        name: `key-${Date.now()}`,
      })
      .returning({ id: apiKeys.id });

    await testDb.db.execute(BACKFILL_SQL_TEST_VARIANT);

    const after = await testDb.db.execute<{ group_id: string | null }>(sql`
      SELECT group_id FROM api_keys WHERE id = ${key!.id}
    `);
    const group = await testDb.db.execute<{ id: string }>(sql`
      SELECT id FROM account_groups
      WHERE org_id = ${org.id} AND name = 'legacy-anthropic'
    `);
    expect(after.rows[0]!.group_id).toBe(group.rows[0]!.id);
  });

  it("(org_id, name) UNIQUE prevents duplicate legacy-anthropic groups within an org", async () => {
    const org = await makeOrg(testDb.db);
    await testDb.db.insert(accountGroups).values({
      orgId: org.id,
      name: "dup-test",
      platform: "anthropic",
    });
    await expect(
      testDb.db.insert(accountGroups).values({
        orgId: org.id,
        name: "dup-test",
        platform: "openai",
      }),
    ).rejects.toMatchObject({
      cause: { code: "23505", constraint: "account_groups_org_name_unique" },
    });
  });

  it("ON DELETE CASCADE removes account_group_members when their account_groups parent is deleted", async () => {
    const org = await makeOrg(testDb.db);
    const [acct] = await testDb.db
      .insert(upstreamAccounts)
      .values({
        orgId: org.id,
        name: `cascade-${Date.now()}`,
        platform: "openai",
        type: "oauth",
      })
      .returning({ id: upstreamAccounts.id });
    const [grp] = await testDb.db
      .insert(accountGroups)
      .values({
        orgId: org.id,
        name: `cascade-${Date.now()}`,
        platform: "openai",
      })
      .returning({ id: accountGroups.id });
    await testDb.db.insert(accountGroupMembers).values({
      accountId: acct!.id,
      groupId: grp!.id,
    });

    await testDb.db.execute(
      sql`DELETE FROM account_groups WHERE id = ${grp!.id}`,
    );

    const after = await testDb.db.execute<{ count: string }>(sql`
      SELECT COUNT(*)::text AS count FROM account_group_members
      WHERE group_id = ${grp!.id}
    `);
    expect(after.rows[0]!.count).toBe("0");
  });

  it("ON DELETE SET NULL nulls api_keys.group_id when its account_groups parent is deleted", async () => {
    const org = await makeOrg(testDb.db);
    const user = await makeUser(testDb.db, { orgId: org.id });
    const [grp] = await testDb.db
      .insert(accountGroups)
      .values({
        orgId: org.id,
        name: `set-null-${Date.now()}`,
        platform: "openai",
      })
      .returning({ id: accountGroups.id });
    const [key] = await testDb.db
      .insert(apiKeys)
      .values({
        userId: user.id,
        orgId: org.id,
        groupId: grp!.id,
        keyHash: `set-null-h-${Date.now()}`,
        keyPrefix: "ak_t",
        name: `set-null-key-${Date.now()}`,
      })
      .returning({ id: apiKeys.id });

    await testDb.db.execute(
      sql`DELETE FROM account_groups WHERE id = ${grp!.id}`,
    );

    const after = await testDb.db.execute<{ group_id: string | null }>(sql`
      SELECT group_id FROM api_keys WHERE id = ${key!.id}
    `);
    expect(after.rows[0]!.group_id).toBeNull();
  });
});

describe("migration 0008 down migration", () => {
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await setupTestDb();
  });

  afterAll(async () => {
    await testDb.stop();
  });

  it("0008_down.sql reverses the schema cleanly", async () => {
    // Down SQL is hand-applied per the file's own header comment. Mirrors
    // 0008_down.sql contents — keep this block in sync if the file changes.
    //
    // setupTestDb() applies all migrations through the latest, so 0010 and
    // 0009 may have introduced dependents on the 0008 schema (notably
    // usage_logs.group_id → account_groups). Real-world rollback order is
    // 0010_down → 0009_down → 0008_down; mirror that here so the FK is
    // dropped before account_groups disappears.
    await testDb.db.execute(sql`
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
      DROP TABLE IF EXISTS model_pricing;
    `);

    await testDb.db.execute(sql`
      ALTER TABLE upstream_accounts
        DROP CONSTRAINT IF EXISTS subscription_tier_values;
      ALTER TABLE upstream_accounts
        DROP COLUMN IF EXISTS subscription_tier;
      DROP INDEX IF EXISTS api_keys_group_idx;
      ALTER TABLE api_keys DROP COLUMN IF EXISTS group_id;
      DROP TABLE IF EXISTS account_group_members;
      DROP TABLE IF EXISTS account_groups;
    `);

    const groupsTable = await testDb.db.execute<{ exists: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_name = 'account_groups'
      ) AS exists
    `);
    expect(groupsTable.rows[0]!.exists).toBe(false);

    const membersTable = await testDb.db.execute<{ exists: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_name = 'account_group_members'
      ) AS exists
    `);
    expect(membersTable.rows[0]!.exists).toBe(false);

    const groupIdCol = await testDb.db.execute<{ exists: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'api_keys' AND column_name = 'group_id'
      ) AS exists
    `);
    expect(groupIdCol.rows[0]!.exists).toBe(false);

    const tierCol = await testDb.db.execute<{ exists: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'upstream_accounts'
          AND column_name = 'subscription_tier'
      ) AS exists
    `);
    expect(tierCol.rows[0]!.exists).toBe(false);
  });
});
