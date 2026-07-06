// apps/api/tests/integration/migrations/0024.test.ts
//
// Covers organizations.agent_poll_interval_seconds:
//   - nullable integer column (NULL = use the server default 60)

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { setupTestDb } from "../../factories/index.js";

let testDb: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
  testDb = await setupTestDb();
});
afterAll(async () => {
  await testDb.stop();
});

describe("migration 0024", () => {
  it("adds nullable agent_poll_interval_seconds to organizations", async () => {
    const { rows } = await testDb.pool.query(
      `SELECT data_type, is_nullable FROM information_schema.columns
       WHERE table_name = 'organizations' AND column_name = 'agent_poll_interval_seconds'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].data_type).toBe("integer");
    expect(rows[0].is_nullable).toBe("YES");
  });
});
