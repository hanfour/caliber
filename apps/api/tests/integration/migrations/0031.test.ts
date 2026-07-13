import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { rubricSchema, platformRubricV2En } from "@caliber/evaluator";
import { setupTestDb, type TestDb } from "../../factories/db.js";

/**
 * Task 10 (rubric v2 plan) — migration 0031 seed platform rubric v2.0.0.
 *
 * Verifies:
 *   1. Exactly 3 rows with org_id NULL AND version '2.0.0' — one per
 *      locale (en / zh-Hant / ja).
 *   2. Each definition parses cleanly against `rubricSchema`.
 *   3. Each row's is_default is false (calibration pending; flipping the
 *      default is a separate migration per docs/RUBRIC_V2_DESIGN.md §8).
 *   4. The pre-existing v1 platform-default rows (3, from migration 0003)
 *      are untouched and still is_default = true.
 *   5. Stronger than the plan minimum: the en row's definition deep-equals
 *      the `platformRubricV2En` TS const exported from @caliber/evaluator,
 *      proving the SQL seed and the TS source have byte-for-byte parity.
 */
describe("migration 0031 seed platform rubric v2.0.0", () => {
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await setupTestDb();
  });

  afterAll(async () => {
    await testDb.stop();
  });

  it("inserts exactly 3 rows with org_id NULL and version 2.0.0", async () => {
    const rows = await testDb.db.execute<{ locale: string }>(sql`
      SELECT definition->>'locale' AS locale
      FROM rubrics
      WHERE org_id IS NULL AND version = '2.0.0'
      ORDER BY locale
    `);
    expect(rows.rows.length).toBe(3);
    expect(rows.rows.map((r) => r.locale)).toEqual(["en", "ja", "zh-Hant"]);
  });

  it("each v2 rubric definition parses against rubricSchema", async () => {
    const rows = await testDb.db.execute<{ definition: unknown }>(sql`
      SELECT definition
      FROM rubrics
      WHERE org_id IS NULL AND version = '2.0.0'
    `);
    expect(rows.rows.length).toBe(3);
    for (const r of rows.rows) {
      const result = rubricSchema.safeParse(r.definition);
      if (!result.success) {
        throw new Error(
          `rubric did not parse: ${JSON.stringify(result.error.issues)}`,
        );
      }
      expect(result.data.version).toBe("2.0.0");
    }
  });

  it("each v2 rubric row has is_default = false (calibration pending)", async () => {
    const rows = await testDb.db.execute<{ is_default: boolean }>(sql`
      SELECT is_default
      FROM rubrics
      WHERE org_id IS NULL AND version = '2.0.0'
    `);
    expect(rows.rows.length).toBe(3);
    for (const r of rows.rows) {
      expect(r.is_default).toBe(false);
    }
  });

  it("leaves the pre-existing v1 platform-default rows untouched (still is_default = true)", async () => {
    const rows = await testDb.db.execute<{ is_default: boolean }>(sql`
      SELECT is_default
      FROM rubrics
      WHERE org_id IS NULL AND is_default = true
    `);
    expect(rows.rows.length).toBe(3);
    for (const r of rows.rows) {
      expect(r.is_default).toBe(true);
    }
  });

  it("the en row's definition deep-equals the platformRubricV2En TS const (SQL/TS parity)", async () => {
    const rows = await testDb.db.execute<{ definition: unknown }>(sql`
      SELECT definition
      FROM rubrics
      WHERE org_id IS NULL AND version = '2.0.0' AND definition->>'locale' = 'en'
    `);
    expect(rows.rows.length).toBe(1);
    expect(rows.rows[0]!.definition).toEqual(platformRubricV2En);
  });
});
