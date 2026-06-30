/**
 * Integration tests for createLedgerWriter (Plan 4C, Task 3.3).
 *
 * Verifies the concrete `insertLedger` factory wired against a real Postgres
 * testcontainer + Drizzle. The writer is consumed by `callWithCostTracking`
 * (from `@caliber/evaluator`) to record LLM spend after each successful call.
 *
 * Confirms:
 *   - inserts all fields including `refType` / `refId`
 *   - inserts with NULL `ref_type` / `ref_id` when omitted
 *   - supports multiple inserts for the same org
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { sql } from "drizzle-orm";
import pg from "pg";
import path from "node:path";
import { createRequire } from "node:module";
import { organizations, type Database } from "@caliber/db";
import { createLedgerWriter } from "../../../src/workers/evaluator/ledgerWriter.js";

const require = createRequire(import.meta.url);
const migrationsFolder = path.resolve(
  path.dirname(require.resolve("@caliber/db/package.json")),
  "drizzle",
);

let pgContainer: StartedPostgreSqlContainer;
let pool: pg.Pool;
let db: Database;

beforeAll(async () => {
  pgContainer = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = new pg.Pool({ connectionString: pgContainer.getConnectionUri() });
  db = drizzle(pool) as unknown as Database;
  await migrate(db, { migrationsFolder });
}, 120_000);

afterAll(async () => {
  await pool.end();
  await pgContainer.stop();
});

let orgId: string;

beforeEach(async () => {
  // CASCADE wipes child tables (llm_usage_events) along with organizations.
  await db.execute(sql`TRUNCATE TABLE organizations RESTART IDENTITY CASCADE`);
  const slug = `ledger-writer-${Math.random().toString(36).slice(2, 10)}`;
  const [row] = await db
    .insert(organizations)
    .values({ slug, name: slug })
    .returning({ id: organizations.id });
  orgId = row!.id;
});

describe("createLedgerWriter (integration)", () => {
  it("inserts a ledger row with all fields including refType/refId", async () => {
    const write = createLedgerWriter(db);
    await write({
      orgId,
      eventType: "facet_extraction",
      model: "claude-haiku-4-5",
      tokensInput: 100,
      tokensOutput: 50,
      costUsd: 0.0002,
      refType: "request_body_facet",
      refId: "11111111-1111-1111-1111-111111111111",
    });

    const rows = await db.execute<{
      org_id: string;
      event_type: string;
      model: string;
      tokens_input: number;
      tokens_output: number;
      cost_usd: string;
      ref_type: string | null;
      ref_id: string | null;
    }>(sql`SELECT * FROM llm_usage_events WHERE org_id = ${orgId}`);

    expect(rows.rows).toHaveLength(1);
    const inserted = rows.rows[0]!;
    expect(inserted.event_type).toBe("facet_extraction");
    expect(inserted.model).toBe("claude-haiku-4-5");
    expect(inserted.tokens_input).toBe(100);
    expect(inserted.tokens_output).toBe(50);
    expect(Number(inserted.cost_usd)).toBeCloseTo(0.0002, 6);
    expect(inserted.ref_type).toBe("request_body_facet");
    expect(inserted.ref_id).toBe("11111111-1111-1111-1111-111111111111");
  });

  it("inserts with null ref_type / ref_id when omitted", async () => {
    const write = createLedgerWriter(db);
    await write({
      orgId,
      eventType: "deep_analysis",
      model: "claude-sonnet-4-6",
      tokensInput: 1,
      tokensOutput: 1,
      costUsd: 0.0001,
    });

    const rows = await db.execute<{
      ref_type: string | null;
      ref_id: string | null;
    }>(
      sql`SELECT ref_type, ref_id FROM llm_usage_events WHERE org_id = ${orgId}`,
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.ref_type).toBeNull();
    expect(rows.rows[0]!.ref_id).toBeNull();
  });

  it("can insert multiple ledger rows for the same org", async () => {
    const write = createLedgerWriter(db);
    await write({
      orgId,
      eventType: "facet_extraction",
      model: "claude-haiku-4-5",
      tokensInput: 100,
      tokensOutput: 100,
      costUsd: 0.0008,
    });
    await write({
      orgId,
      eventType: "deep_analysis",
      model: "claude-sonnet-4-6",
      tokensInput: 500,
      tokensOutput: 200,
      costUsd: 0.0045,
    });

    const rows = await db.execute<{ count: string }>(
      sql`SELECT COUNT(*)::text AS count FROM llm_usage_events WHERE org_id = ${orgId}`,
    );
    expect(rows.rows[0]!.count).toBe("2");
  });

  it("dedup: writing the same (ref_type, ref_id, event_type) twice results in exactly one row", async () => {
    // Regression guard for BullMQ crash-window retries. The partial unique
    // index llm_usage_dedup_idx on (ref_type, ref_id, event_type) WHERE ref_id
    // IS NOT NULL should cause the second write to be a no-op via
    // onConflictDoNothing — matching the deep-analysis ledger dedup contract.
    const write = createLedgerWriter(db);
    const dupRow = {
      orgId,
      eventType: "facet_extraction",
      model: "claude-haiku-4-5",
      tokensInput: 100,
      tokensOutput: 50,
      costUsd: 0.0002,
      refType: "request_body_facet",
      refId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    } as const;

    await write(dupRow);
    // Second identical write (simulating a crash-window retry).
    await write(dupRow);

    const rows = await db.execute<{ count: string }>(
      sql`SELECT COUNT(*)::text AS count FROM llm_usage_events WHERE org_id = ${orgId}`,
    );
    expect(rows.rows[0]!.count).toBe("1");
  });

  it("increments gwLlmCostUsdTotal with the right labels and value when metrics are provided (Plan 4C, Part 7)", async () => {
    const inc = vi.fn();
    // We only exercise `.inc`; the full prom-client Counter type is unneeded.
    const metricsStub = {
      gwLlmCostUsdTotal: { inc },
    } as never;
    const write = createLedgerWriter(db, metricsStub);

    await write({
      orgId,
      eventType: "facet_extraction",
      model: "claude-haiku-4-5",
      tokensInput: 10,
      tokensOutput: 5,
      costUsd: 0.0123,
    });

    expect(inc).toHaveBeenCalledTimes(1);
    expect(inc).toHaveBeenCalledWith(
      {
        org_id: orgId,
        event_type: "facet_extraction",
        model: "claude-haiku-4-5",
      },
      0.0123,
    );

    // Confirm the row still landed in the DB so we know the metric tap
    // didn't replace the insert.
    const rows = await db.execute<{ count: string }>(
      sql`SELECT COUNT(*)::text AS count FROM llm_usage_events WHERE org_id = ${orgId}`,
    );
    expect(rows.rows[0]!.count).toBe("1");
  });
});
