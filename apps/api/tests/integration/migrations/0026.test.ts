// apps/api/tests/integration/migrations/0026.test.ts
//
// #261: migration 0026 raises interaction_keywords minRatio to 0.50 (leaving
// security/performance keyword signals at 0.40) and bumps platform rubrics to
// 1.3.0, so comparison/iteration language must appear in at least half a
// member's turns to earn the "superior decision-making" gate.

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { setupTestDb } from "../../factories/index.js";

let testDb: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
  testDb = await setupTestDb();
});
afterAll(async () => {
  await testDb.stop();
});

describe("migration 0026", () => {
  it("sets interaction_keywords minRatio to 0.5 and keeps others at 0.4 (v1.3.0)", async () => {
    const { rows } = await testDb.pool.query(
      `SELECT version, definition FROM rubrics
       WHERE org_id IS NULL AND api_key_id IS NULL AND is_default = true`,
    );
    expect(rows.length).toBeGreaterThan(0);

    for (const r of rows) {
      expect(r.version).toBe("1.3.0");
      const sections = r.definition.sections as Array<{
        signals: Array<{ type: string; id: string; minRatio?: number }>;
      }>;
      const keyword = sections.flatMap((s) =>
        s.signals.filter((sig) => sig.type === "keyword"),
      );
      const interaction = keyword.find((s) => s.id === "interaction_keywords");
      expect(interaction?.minRatio).toBe(0.5);
      for (const sig of keyword.filter((s) => s.id !== "interaction_keywords")) {
        expect(sig.minRatio).toBe(0.4);
      }
    }
  });
});
