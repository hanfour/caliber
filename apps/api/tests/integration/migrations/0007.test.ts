import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { rubricSchema } from "@caliber/evaluator";
import { setupTestDb, type TestDb } from "../../factories/db.js";

/**
 * Plan 4C follow-up #2 — migration 0007 platform rubric v2 facets.
 *
 * Verifies:
 *   1. Each platform-default rubric was bumped to version 1.1.0.
 *   2. Each rubric still parses cleanly against `rubricSchema` (no shape
 *      regression, the new facet signal types are recognised).
 *   3. Both sections gained their respective facet support signal +
 *      supportThresholds reference; existing strong/support entries are
 *      preserved (strictly additive).
 *   4. minStrongHits / minSupportHits unchanged (so orgs without facet
 *      data see no scoring change).
 */
describe("migration 0007 platform rubric v2 facets", () => {
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await setupTestDb();
  });

  afterAll(async () => {
    await testDb.stop();
  });

  // NB: this reads the FINAL DB state after the whole chain. Migration 0025
  // (#261) later bumps the platform rubrics to 1.2.0 and adds keyword minRatio,
  // so the current head-of-chain version is 1.2.0 (0007's other effects below
  // — facet signals, superiorRules — are untouched by 0025).
  it("keeps all 3 platform-default rubrics at the current version (1.2.0 post-0025)", async () => {
    const rows = await testDb.db.execute<{ version: string; locale: string }>(sql`
      SELECT version, definition->>'locale' AS locale
      FROM rubrics
      WHERE is_default = true AND org_id IS NULL
      ORDER BY locale
    `);
    expect(rows.rows.length).toBe(3);
    for (const r of rows.rows) {
      expect(r.version).toBe("1.2.0");
    }
    expect(rows.rows.map((r) => r.locale).sort()).toEqual([
      "en",
      "ja",
      "zh-Hant",
    ]);
  });

  it("each platform rubric definition parses against rubricSchema", async () => {
    const rows = await testDb.db.execute<{ definition: unknown }>(sql`
      SELECT definition
      FROM rubrics
      WHERE is_default = true AND org_id IS NULL
    `);
    for (const r of rows.rows) {
      const result = rubricSchema.safeParse(r.definition);
      if (!result.success) {
        throw new Error(
          `rubric did not parse: ${JSON.stringify(result.error.issues)}`,
        );
      }
      expect(result.data.version).toBe("1.2.0");
    }
  });

  it("both sections gained facet support signals + threshold references", async () => {
    const rows = await testDb.db.execute<{ definition: unknown }>(sql`
      SELECT definition
      FROM rubrics
      WHERE is_default = true AND org_id IS NULL
      LIMIT 1
    `);
    const def = rubricSchema.parse(rows.rows[0]!.definition);

    // Section 0 (interaction): facet_outcome_success_rate added as support
    const interaction = def.sections[0]!;
    expect(interaction.id).toBe("interaction");
    const interactionFacet = interaction.signals.find(
      (s) => s.id === "facet_outcome_success",
    );
    expect(interactionFacet?.type).toBe("facet_outcome_success_rate");
    if (interactionFacet?.type === "facet_outcome_success_rate") {
      expect(interactionFacet.gte).toBe(0.5);
    }
    expect(interaction.superiorRules?.supportThresholds).toContain(
      "facet_outcome_success",
    );

    // Section 1 (riskControl): facet_bugs_caught added as support
    const riskControl = def.sections[1]!;
    expect(riskControl.id).toBe("riskControl");
    const riskFacet = riskControl.signals.find(
      (s) => s.id === "facet_bugs_caught",
    );
    expect(riskFacet?.type).toBe("facet_bugs_caught");
    if (riskFacet?.type === "facet_bugs_caught") {
      expect(riskFacet.gte).toBe(1);
    }
    expect(riskControl.superiorRules?.supportThresholds).toContain(
      "facet_bugs_caught",
    );
  });

  it("preserves all v1 signals + thresholds (strictly additive)", async () => {
    const rows = await testDb.db.execute<{ definition: unknown }>(sql`
      SELECT definition
      FROM rubrics
      WHERE is_default = true AND org_id IS NULL
      LIMIT 1
    `);
    const def = rubricSchema.parse(rows.rows[0]!.definition);

    // interaction section retains: interaction_keywords (strong),
    // iterative_exploration + multi_tool_usage (support)
    const interaction = def.sections[0]!;
    expect(interaction.superiorRules?.strongThresholds).toEqual([
      "interaction_keywords",
    ]);
    expect(interaction.superiorRules?.supportThresholds).toEqual(
      expect.arrayContaining([
        "iterative_exploration",
        "multi_tool_usage",
        "facet_outcome_success",
      ]),
    );
    expect(interaction.superiorRules?.minStrongHits).toBe(1);
    expect(interaction.superiorRules?.minSupportHits).toBe(1);

    // riskControl section retains: security_keywords + performance_keywords (strong),
    // low_refusal_rate (support)
    const riskControl = def.sections[1]!;
    expect(riskControl.superiorRules?.strongThresholds).toEqual([
      "security_keywords",
      "performance_keywords",
    ]);
    expect(riskControl.superiorRules?.supportThresholds).toEqual(
      expect.arrayContaining(["low_refusal_rate", "facet_bugs_caught"]),
    );
    expect(riskControl.superiorRules?.minStrongHits).toBe(1);
    expect(riskControl.superiorRules?.minSupportHits).toBe(0);
  });
});
