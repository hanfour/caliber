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
      // Head-of-chain version (0026 bumps to 1.3.0); this test asserts 0025's
      // durable effect: every keyword signal carries a minRatio.
      expect(r.version).toBe("1.3.0");
      const sections = r.definition.sections as Array<{
        signals: Array<{ type: string; id: string; minRatio?: number }>;
      }>;
      const keywordSignals = sections.flatMap((s) =>
        s.signals.filter((sig) => sig.type === "keyword"),
      );
      expect(keywordSignals.length).toBeGreaterThan(0);
      for (const sig of keywordSignals) {
        // 0025 set all to 0.4; 0026 raised interaction_keywords to 0.5.
        expect(sig.minRatio).toBeGreaterThanOrEqual(0.4);
      }
    }
  });
});
