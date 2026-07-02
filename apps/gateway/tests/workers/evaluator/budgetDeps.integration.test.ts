/**
 * Integration tests for createBudgetDeps (Plan 4C, Task 3.2).
 *
 * Verifies the concrete `EnforceBudgetDeps` factory wired against a real
 * Postgres testcontainer + Drizzle. Confirms:
 *   - loadOrg returns the snake_case shape required by enforceBudget
 *   - getMonthSpend sums only current-month rows for the given org
 *   - getMonthSpend returns 0 when the ledger is empty
 *   - setHalt / clearHalt flip the persisted flag
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
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
import { createBudgetDeps } from "../../../src/workers/evaluator/budgetDeps.js";

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
  pool.on("error", () => {});  // swallow 57P01 admin-shutdown on container teardown
  db = drizzle(pool) as unknown as Database;
  await migrate(db, { migrationsFolder });
}, 120_000);

afterAll(async () => {
  await pool.end();
  await pgContainer.stop();
});

beforeEach(async () => {
  // CASCADE wipes child tables (llm_usage_events) along with organizations.
  await db.execute(sql`TRUNCATE TABLE organizations RESTART IDENTITY CASCADE`);
});

async function seedOrg(
  overrides: Partial<{
    slug: string;
    name: string;
    llmMonthlyBudgetUsd: string | null;
    llmBudgetOverageBehavior: "degrade" | "halt";
    llmHaltedUntilMonthEnd: boolean;
  }> = {},
): Promise<{ id: string }> {
  const slug =
    overrides.slug ?? `budget-deps-${Math.random().toString(36).slice(2, 10)}`;
  const [row] = await db
    .insert(organizations)
    .values({
      slug,
      name: overrides.name ?? slug,
      llmMonthlyBudgetUsd: overrides.llmMonthlyBudgetUsd ?? null,
      llmBudgetOverageBehavior: overrides.llmBudgetOverageBehavior ?? "degrade",
      llmHaltedUntilMonthEnd: overrides.llmHaltedUntilMonthEnd ?? false,
    })
    .returning({ id: organizations.id });
  return { id: row!.id };
}

describe("createBudgetDeps (integration)", () => {
  it("loadOrg returns the snake_case OrgBudgetState shape", async () => {
    const org = await seedOrg({ llmMonthlyBudgetUsd: "50.00" });
    const deps = createBudgetDeps(db);

    const loaded = await deps.loadOrg(org.id);

    expect(loaded.id).toBe(org.id);
    expect(loaded.llm_monthly_budget_usd).toBe(50);
    expect(loaded.llm_budget_overage_behavior).toBe("degrade");
    expect(loaded.llm_halted_until_month_end).toBe(false);
    // halt_set_at is intentionally undefined — see budgetDeps.ts TODO.
    expect(loaded.halt_set_at).toBeUndefined();
  });

  it("loadOrg returns null budget when llmMonthlyBudgetUsd is unset (unlimited)", async () => {
    const org = await seedOrg({ llmMonthlyBudgetUsd: null });
    const deps = createBudgetDeps(db);

    const loaded = await deps.loadOrg(org.id);

    expect(loaded.llm_monthly_budget_usd).toBeNull();
  });

  it("loadOrg honors halt overage behavior", async () => {
    const org = await seedOrg({
      llmMonthlyBudgetUsd: "10.00",
      llmBudgetOverageBehavior: "halt",
    });
    const deps = createBudgetDeps(db);

    const loaded = await deps.loadOrg(org.id);

    expect(loaded.llm_budget_overage_behavior).toBe("halt");
  });

  it("loadOrg throws when the org does not exist", async () => {
    const deps = createBudgetDeps(db);
    await expect(
      deps.loadOrg("00000000-0000-0000-0000-000000000000"),
    ).rejects.toThrow(/not found/i);
  });

  it("getMonthSpend sums only current-month ledger rows for the org", async () => {
    const org = await seedOrg();
    const otherOrg = await seedOrg({ slug: "other-budget-org" });

    await db.execute(sql`
      INSERT INTO llm_usage_events
        (org_id, event_type, model, tokens_input, tokens_output, cost_usd, created_at)
      VALUES
        (${org.id}, 'facet_extraction', 'claude-haiku-4-5', 100, 100, 1.5, '2026-04-01T00:00:00Z'),
        (${org.id}, 'deep_analysis',    'claude-sonnet-4-6', 200, 200, 2.5, '2026-04-10T00:00:00Z'),
        (${org.id}, 'facet_extraction', 'claude-haiku-4-5', 100, 100, 0.5, '2026-03-31T23:59:00Z'),
        (${org.id}, 'facet_extraction', 'claude-haiku-4-5', 100, 100, 0.7, '2026-05-01T00:00:00Z'),
        (${otherOrg.id}, 'facet_extraction', 'claude-haiku-4-5', 100, 100, 9.99, '2026-04-15T00:00:00Z')
    `);

    const deps = createBudgetDeps(db);
    const spend = await deps.getMonthSpend(
      org.id,
      new Date("2026-04-01T00:00:00Z"),
    );

    expect(spend).toBeCloseTo(4.0, 6);
  });

  it("getMonthSpend returns 0 when no ledger rows exist", async () => {
    const org = await seedOrg();
    const deps = createBudgetDeps(db);

    const spend = await deps.getMonthSpend(
      org.id,
      new Date("2026-04-01T00:00:00Z"),
    );

    expect(spend).toBe(0);
  });

  it("setHalt / clearHalt flip the persisted flag", async () => {
    const org = await seedOrg();
    const deps = createBudgetDeps(db);

    await deps.setHalt(org.id);
    let loaded = await deps.loadOrg(org.id);
    expect(loaded.llm_halted_until_month_end).toBe(true);

    await deps.clearHalt(org.id);
    loaded = await deps.loadOrg(org.id);
    expect(loaded.llm_halted_until_month_end).toBe(false);
  });

  it("setHalt populates halt_set_at timestamp; clearHalt clears it", async () => {
    const org = await seedOrg();
    const deps = createBudgetDeps(db);

    // Initially no halt timestamp.
    let loaded = await deps.loadOrg(org.id);
    expect(loaded.halt_set_at).toBeUndefined();

    const before = Date.now();
    await deps.setHalt(org.id);
    const after = Date.now();

    loaded = await deps.loadOrg(org.id);
    expect(loaded.halt_set_at).toBeInstanceOf(Date);
    const ts = loaded.halt_set_at!.getTime();
    // Allow a small clock-skew tolerance against the test container.
    expect(ts).toBeGreaterThanOrEqual(before - 1000);
    expect(ts).toBeLessThanOrEqual(after + 1000);

    await deps.clearHalt(org.id);
    loaded = await deps.loadOrg(org.id);
    expect(loaded.halt_set_at).toBeUndefined();
  });

  it("now returns a Date close to the wall clock", () => {
    const deps = createBudgetDeps(db);
    const before = Date.now();
    const got = deps.now();
    const after = Date.now();

    expect(got).toBeInstanceOf(Date);
    expect(got.getTime()).toBeGreaterThanOrEqual(before);
    expect(got.getTime()).toBeLessThanOrEqual(after);
  });
});
