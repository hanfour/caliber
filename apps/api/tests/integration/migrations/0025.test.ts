// apps/api/tests/integration/migrations/0025.test.ts
//
// #261: migration 0025 adds minRatio to every keyword signal in the
// platform-default rubrics and bumps their version to 1.2.0, so telemetry
// volume no longer auto-saturates the "any body contains a term" gate.

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { setupTestDb } from "../../factories/index.js";

let testDb: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
  testDb = await setupTestDb();
});
afterAll(async () => {
  await testDb.stop();
});

describe("migration 0025", () => {
  it("adds minRatio=0.4 to every keyword signal and bumps platform rubrics to 1.2.0", async () => {
    const { rows } = await testDb.pool.query(
      `SELECT version, definition FROM rubrics
       WHERE org_id IS NULL AND api_key_id IS NULL AND is_default = true`,
    );
    expect(rows.length).toBeGreaterThan(0);

    for (const r of rows) {
      expect(r.version).toBe("1.2.0");
      const sections = r.definition.sections as Array<{
        signals: Array<{ type: string; minRatio?: number }>;
      }>;
      const keywordSignals = sections.flatMap((s) =>
        s.signals.filter((sig) => sig.type === "keyword"),
      );
      // The platform rubric has keyword signals; every one must now carry minRatio.
      expect(keywordSignals.length).toBeGreaterThan(0);
      for (const sig of keywordSignals) {
        expect(sig.minRatio).toBe(0.4);
      }
    }
  });
});
