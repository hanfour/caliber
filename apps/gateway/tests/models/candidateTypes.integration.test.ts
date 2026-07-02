/**
 * Integration tests for `listCandidateTypes` — the read-only helper that
 * projects the scheduler's candidate query down to the DISTINCT credential
 * `type`s ("api_key" | "oauth") of upstreams that could serve a request scope.
 *
 * Drives the real candidate query against a Postgres testcontainer (mirroring
 * the schedulerOwnership integration harness) so it inherits the exact
 * routingPolicy / platform / schedulable filtering the scheduler uses, and
 * asserts:
 *   - a scope with one oauth + one api_key upstream returns BOTH (deduped)
 *   - duplicate types collapse to a single entry (DISTINCT)
 *   - a single-type scope returns exactly that one type
 *   - the helper respects ownership scoping (pool excludes user-owned)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import path from "node:path";
import { createRequire } from "node:module";
import { sql } from "drizzle-orm";
import { organizations, users, upstreamAccounts } from "@caliber/db";
import type { ScheduleRequest } from "../../src/runtime/scheduler.js";
import { listCandidateTypes } from "../../src/models/candidateTypes.js";

const require = createRequire(import.meta.url);
const migrationsFolder = path.resolve(
  path.dirname(require.resolve("@caliber/db/package.json")),
  "drizzle",
);

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let db: ReturnType<typeof drizzle>;
let orgId: string;
let userAId: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = new pg.Pool({ connectionString: container.getConnectionUri() });
  pool.on("error", () => {});  // swallow 57P01 admin-shutdown on container teardown
  db = drizzle(pool);
  await migrate(db, { migrationsFolder });

  const [org] = await db
    .insert(organizations)
    .values({ slug: "candidate-types-test-org", name: "Candidate Types Test" })
    .returning();
  orgId = org!.id;

  const [userA] = await db
    .insert(users)
    .values({ email: "candidate-types-owner-a@example.com" })
    .returning();
  userAId = userA!.id;
}, 90_000);

afterAll(async () => {
  await pool.end();
  await container.stop();
}, 30_000);

beforeEach(async () => {
  await db.execute(
    sql`TRUNCATE TABLE upstream_accounts RESTART IDENTITY CASCADE`,
  );
});

const baseAccount = {
  teamId: null as string | null,
  platform: "openai" as const,
  type: "api_key" as const,
  schedulable: true,
  status: "active" as const,
};

async function seedAccount(
  overrides: Partial<typeof upstreamAccounts.$inferInsert> = {},
) {
  const [acct] = await db
    .insert(upstreamAccounts)
    .values({ ...baseAccount, orgId, name: "anon", priority: 50, ...overrides })
    .returning();
  return acct!;
}

function poolReq(overrides: Partial<ScheduleRequest> = {}): ScheduleRequest {
  return {
    orgId,
    teamId: null,
    routingPolicy: "pool",
    userId: null,
    groupPlatform: "openai",
    ...overrides,
  };
}

describe("listCandidateTypes", () => {
  it("returns BOTH types when the scope has one oauth + one api_key upstream", async () => {
    await seedAccount({ name: "api-key-acct", type: "api_key" });
    await seedAccount({ name: "oauth-acct", type: "oauth" });

    const types = await listCandidateTypes(db as never, poolReq());

    expect([...types].sort()).toEqual(["api_key", "oauth"]);
  });

  it("dedupes: many upstreams of the same type collapse to one entry", async () => {
    await seedAccount({ name: "api-key-1", type: "api_key" });
    await seedAccount({ name: "api-key-2", type: "api_key" });
    await seedAccount({ name: "oauth-1", type: "oauth" });
    await seedAccount({ name: "oauth-2", type: "oauth" });

    const types = await listCandidateTypes(db as never, poolReq());

    expect(types).toHaveLength(2);
    expect([...types].sort()).toEqual(["api_key", "oauth"]);
  });

  it("returns a single type for a single-type scope", async () => {
    await seedAccount({ name: "only-oauth", type: "oauth" });

    const types = await listCandidateTypes(db as never, poolReq());

    expect(types).toEqual(["oauth"]);
  });

  it("returns nothing when no upstream can serve the scope", async () => {
    // Only a user-owned upstream exists; a pool request must not see it, so
    // there are no candidates and therefore no types.
    await seedAccount({ name: "user-owned", type: "oauth", userId: userAId });

    const types = await listCandidateTypes(db as never, poolReq());

    expect(types).toEqual([]);
  });

  it("respects ownership scoping (pool excludes user-owned types)", async () => {
    await seedAccount({ name: "pool-api-key", type: "api_key" });
    await seedAccount({ name: "user-oauth", type: "oauth", userId: userAId });

    const types = await listCandidateTypes(db as never, poolReq());

    // The user-owned oauth upstream must NOT leak its type into a pool scope.
    expect(types).toEqual(["api_key"]);
  });
});
