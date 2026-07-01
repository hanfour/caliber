// apps/api/tests/integration/migrations/0023.test.ts
//
// Covers rubrics.api_key_id key-scope:
//   - nullable FK column api_key_id → api_keys(id) ON DELETE CASCADE
//   - partial unique index rubrics_api_key_uniq WHERE api_key_id IS NOT NULL AND deleted_at IS NULL
//   - CHECK rubrics_key_scope_chk: api_key_id IS NULL OR (org_id IS NOT NULL AND is_default = false)
//   - cascade: hard-delete api_key → key rubric gone; org-delete → key rubric gone
//   - existing org/platform rubric inserts unaffected

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { setupTestDb, type TestDb } from "../../factories/index.js";

const uuidv4 = () => crypto.randomUUID();

describe("migration 0023 — rubrics.api_key_id key-scope", () => {
  let t: TestDb;

  beforeAll(async () => {
    t = await setupTestDb();
  });

  afterAll(async () => {
    await t.stop();
  });

  it("column api_key_id exists and is nullable", async () => {
    const col = await t.db.execute(
      sql`SELECT is_nullable FROM information_schema.columns WHERE table_name='rubrics' AND column_name='api_key_id'`
    );
    expect(col.rows[0]).toMatchObject({ is_nullable: "YES" });
  });

  it("partial unique index rubrics_api_key_uniq exists with correct WHERE", async () => {
    const idx = await t.db.execute(
      sql`SELECT indexdef FROM pg_indexes WHERE tablename='rubrics' AND indexname='rubrics_api_key_uniq'`
    );
    expect(idx.rows).toHaveLength(1);
    expect(String(idx.rows[0]!.indexdef)).toMatch(/WHERE.*api_key_id IS NOT NULL.*deleted_at IS NULL/i);
  });

  it("CHECK constraint rubrics_key_scope_chk exists", async () => {
    const chk = await t.db.execute(
      sql`SELECT conname FROM pg_constraint WHERE conname='rubrics_key_scope_chk'`
    );
    expect(chk.rows).toHaveLength(1);
  });

  it("CHECK rejects api_key_id set + is_default=true", async () => {
    // Seed org + user + api_key
    const orgId = uuidv4();
    const userId = uuidv4();
    const keyId = uuidv4();
    await t.pool.query(
      `INSERT INTO organizations (id, slug, name) VALUES ($1, $2, $3)`,
      [orgId, `org-check-${orgId.slice(0, 8)}`, "Org Check"]
    );
    await t.pool.query(
      `INSERT INTO users (id, email) VALUES ($1, $2)`,
      [userId, `u-check-${orgId.slice(0, 8)}@t.test`]
    );
    await t.pool.query(
      `INSERT INTO api_keys (id, user_id, org_id, key_hash, key_prefix, name) VALUES ($1, $2, $3, $4, $5, $6)`,
      [keyId, userId, orgId, `hash-chk-${keyId.slice(0, 8)}`, "ck-", "check key"]
    );

    // api_key_id set + is_default=true → CHECK violation
    await expect(
      t.pool.query(
        `INSERT INTO rubrics (org_id, api_key_id, name, version, definition, is_default)
         VALUES ($1, $2, 'bad', 'v1', '{}', true)`,
        [orgId, keyId]
      )
    ).rejects.toThrow(/rubrics_key_scope_chk/);
  });

  it("CHECK rejects api_key_id set + org_id NULL", async () => {
    const orgId = uuidv4();
    const userId = uuidv4();
    const keyId = uuidv4();
    await t.pool.query(
      `INSERT INTO organizations (id, slug, name) VALUES ($1, $2, $3)`,
      [orgId, `org-chk2-${orgId.slice(0, 8)}`, "Org Chk2"]
    );
    await t.pool.query(
      `INSERT INTO users (id, email) VALUES ($1, $2)`,
      [userId, `u-chk2-${orgId.slice(0, 8)}@t.test`]
    );
    await t.pool.query(
      `INSERT INTO api_keys (id, user_id, org_id, key_hash, key_prefix, name) VALUES ($1, $2, $3, $4, $5, $6)`,
      [keyId, userId, orgId, `hash-chk2-${keyId.slice(0, 8)}`, "c2-", "chk2 key"]
    );

    // api_key_id set + org_id=NULL → CHECK violation
    await expect(
      t.pool.query(
        `INSERT INTO rubrics (org_id, api_key_id, name, version, definition, is_default)
         VALUES (NULL, $1, 'bad2', 'v1', '{}', false)`,
        [keyId]
      )
    ).rejects.toThrow(/rubrics_key_scope_chk/);
  });

  it("unique index rejects a 2nd live key rubric for the same api_key", async () => {
    const orgId = uuidv4();
    const userId = uuidv4();
    const keyId = uuidv4();
    await t.pool.query(
      `INSERT INTO organizations (id, slug, name) VALUES ($1, $2, $3)`,
      [orgId, `org-uniq-${orgId.slice(0, 8)}`, "Org Uniq"]
    );
    await t.pool.query(
      `INSERT INTO users (id, email) VALUES ($1, $2)`,
      [userId, `u-uniq-${orgId.slice(0, 8)}@t.test`]
    );
    await t.pool.query(
      `INSERT INTO api_keys (id, user_id, org_id, key_hash, key_prefix, name) VALUES ($1, $2, $3, $4, $5, $6)`,
      [keyId, userId, orgId, `hash-uniq-${keyId.slice(0, 8)}`, "cu-", "uniq key"]
    );

    // First insert → OK
    await t.pool.query(
      `INSERT INTO rubrics (org_id, api_key_id, name, version, definition, is_default)
       VALUES ($1, $2, 'first', 'v1', '{}', false)`,
      [orgId, keyId]
    );

    // Second live insert for same key → unique violation
    await expect(
      t.pool.query(
        `INSERT INTO rubrics (org_id, api_key_id, name, version, definition, is_default)
         VALUES ($1, $2, 'second', 'v1', '{}', false)`,
        [orgId, keyId]
      )
    ).rejects.toThrow(/rubrics_api_key_uniq/);
  });

  it("hard-delete api_key cascades away its key rubric", async () => {
    const orgId = uuidv4();
    const userId = uuidv4();
    const keyId = uuidv4();
    await t.pool.query(
      `INSERT INTO organizations (id, slug, name) VALUES ($1, $2, $3)`,
      [orgId, `org-casc-${orgId.slice(0, 8)}`, "Org Casc"]
    );
    await t.pool.query(
      `INSERT INTO users (id, email) VALUES ($1, $2)`,
      [userId, `u-casc-${orgId.slice(0, 8)}@t.test`]
    );
    await t.pool.query(
      `INSERT INTO api_keys (id, user_id, org_id, key_hash, key_prefix, name) VALUES ($1, $2, $3, $4, $5, $6)`,
      [keyId, userId, orgId, `hash-casc-${keyId.slice(0, 8)}`, "cc-", "casc key"]
    );
    const rubricId = uuidv4();
    await t.pool.query(
      `INSERT INTO rubrics (id, org_id, api_key_id, name, version, definition, is_default)
       VALUES ($1, $2, $3, 'key-rubric', 'v1', '{}', false)`,
      [rubricId, orgId, keyId]
    );

    // Confirm rubric exists
    const before = await t.pool.query(
      `SELECT id FROM rubrics WHERE id=$1`,
      [rubricId]
    );
    expect(before.rows).toHaveLength(1);

    // Hard-delete the api_key → CASCADE should remove the rubric
    await t.pool.query(`DELETE FROM api_keys WHERE id=$1`, [keyId]);

    const after = await t.pool.query(
      `SELECT id FROM rubrics WHERE id=$1`,
      [rubricId]
    );
    expect(after.rows).toHaveLength(0);
  });

  it("org hard-delete cascades away key rubric (rubrics.org_id ON DELETE CASCADE)", async () => {
    const orgId = uuidv4();
    const userId = uuidv4();
    const keyId = uuidv4();
    await t.pool.query(
      `INSERT INTO organizations (id, slug, name) VALUES ($1, $2, $3)`,
      [orgId, `org-orgd-${orgId.slice(0, 8)}`, "Org OrgDel"]
    );
    await t.pool.query(
      `INSERT INTO users (id, email) VALUES ($1, $2)`,
      [userId, `u-orgd-${orgId.slice(0, 8)}@t.test`]
    );
    await t.pool.query(
      `INSERT INTO api_keys (id, user_id, org_id, key_hash, key_prefix, name) VALUES ($1, $2, $3, $4, $5, $6)`,
      [keyId, userId, orgId, `hash-orgd-${keyId.slice(0, 8)}`, "co-", "orgd key"]
    );
    const rubricId = uuidv4();
    await t.pool.query(
      `INSERT INTO rubrics (id, org_id, api_key_id, name, version, definition, is_default)
       VALUES ($1, $2, $3, 'key-rubric-orgd', 'v1', '{}', false)`,
      [rubricId, orgId, keyId]
    );

    // Hard-delete org → CASCADE on org_id should remove the rubric (and key via api_keys.org_id CASCADE)
    await t.pool.query(`DELETE FROM organizations WHERE id=$1`, [orgId]);

    const after = await t.pool.query(
      `SELECT id FROM rubrics WHERE id=$1`,
      [rubricId]
    );
    expect(after.rows).toHaveLength(0);
  });

  it("existing org rubric inserts are unaffected (api_key_id=NULL is valid)", async () => {
    const orgId = uuidv4();
    await t.pool.query(
      `INSERT INTO organizations (id, slug, name) VALUES ($1, $2, $3)`,
      [orgId, `org-exist-${orgId.slice(0, 8)}`, "Org Existing"]
    );
    // Insert org rubric (no api_key_id)
    const r = await t.pool.query(
      `INSERT INTO rubrics (org_id, name, version, definition, is_default)
       VALUES ($1, 'org-rubric', 'v1', '{}', false) RETURNING id`,
      [orgId]
    );
    expect(r.rows).toHaveLength(1);
  });

  it("platform default rubric (org_id=NULL, is_default=true) is still valid (api_key_id=NULL)", async () => {
    const r = await t.pool.query(
      `INSERT INTO rubrics (name, version, definition, is_default)
       VALUES ('platform-rubric', 'v1', '{}', true) RETURNING id`
    );
    expect(r.rows).toHaveLength(1);
  });

  it("rubrics_org_idx and rubrics_default_idx still exist", async () => {
    const idxs = await t.db.execute(
      sql`SELECT indexname FROM pg_indexes WHERE tablename='rubrics' AND indexname IN ('rubrics_org_idx', 'rubrics_default_idx')`
    );
    expect(idxs.rows).toHaveLength(2);
  });
});
