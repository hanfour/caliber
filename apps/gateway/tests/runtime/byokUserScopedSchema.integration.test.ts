/**
 * Integration test for Task 1: upstream_accounts.user_id ownership column.
 *
 * Stands up a real Postgres testcontainer, migrates the schema, seeds parent
 * FK rows (org + user + team), then verifies:
 *   1. A row with BOTH user_id AND team_id set is rejected by the CHECK constraint.
 *   2. A user-owned upstream (user_id set, team_id null) is accepted.
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
import { organizations, teams, users, upstreamAccounts, type Database } from "@caliber/db";

const require = createRequire(import.meta.url);
const migrationsFolder = path.resolve(
  path.dirname(require.resolve("@caliber/db/package.json")),
  "drizzle",
);

// ── Postgres container ────────────────────────────────────────────────────────

let pgContainer: StartedPostgreSqlContainer;
let pool: pg.Pool;
let db: Database;

// Shared parent FK rows
let orgId: string;
let userId: string;
let teamId: string;

beforeAll(async () => {
  pgContainer = await new PostgreSqlContainer("postgres:16-alpine").start();
  pool = new pg.Pool({ connectionString: pgContainer.getConnectionUri() });
  db = drizzle(pool) as unknown as Database;
  await migrate(db as never, { migrationsFolder });

  // Seed one org
  const [org] = await db
    .insert(organizations)
    .values({ slug: "byok-schema-test-org", name: "BYOK Schema Test Org" })
    .returning();
  orgId = org!.id;

  // Seed one user
  const [user] = await db
    .insert(users)
    .values({ email: "byok-schema-test@example.com" })
    .returning();
  userId = user!.id;

  // Seed one team
  const [team] = await db
    .insert(teams)
    .values({ orgId, name: "BYOK Schema Test Team", slug: "byok-schema-test-team" })
    .returning();
  teamId = team!.id;
}, 90_000);

afterAll(async () => {
  await pool.end();
  await pgContainer.stop();
}, 30_000);

// ── Per-test cleanup ──────────────────────────────────────────────────────────

beforeEach(async () => {
  await db.execute(
    sql`TRUNCATE TABLE upstream_accounts RESTART IDENTITY CASCADE`,
  );
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("upstream_accounts user_id column", () => {
  it("upstream_accounts CHECK rejects a row with both user_id and team_id set", async () => {
    let caughtError: unknown;
    try {
      await db.insert(upstreamAccounts).values({
        orgId,
        teamId,
        userId,
        name: "bad",
        platform: "openai",
        type: "api_key",
      });
    } catch (err) {
      caughtError = err;
    }
    expect(caughtError).toBeDefined();
    const directConstraint = (caughtError as { constraint?: string }).constraint;
    const causeConstraint = (caughtError as { cause?: { constraint?: string } }).cause?.constraint;
    const constraint = directConstraint ?? causeConstraint;
    expect(constraint).toBe("upstream_accounts_user_id_xor_team_id");
  });

  it("accepts a user-owned upstream (user_id set, team_id null)", async () => {
    const [row] = await db
      .insert(upstreamAccounts)
      .values({
        orgId,
        userId,
        name: "byok",
        platform: "openai",
        type: "api_key",
      })
      .returning();
    expect(row!.userId).toBe(userId);
    expect(row!.teamId).toBeNull();
  });

  it("accepts a team-owned upstream (team_id set, user_id null) — existing behavior", async () => {
    const [row] = await db.insert(upstreamAccounts).values({
      orgId, teamId, name: "team-upstream", platform: "openai", type: "api_key",
    }).returning();
    expect(row!.userId).toBeNull();
    expect(row!.teamId).toBe(teamId);
  });

  it("accepts an org-pooled upstream (both user_id and team_id null)", async () => {
    const [row] = await db.insert(upstreamAccounts).values({
      orgId, name: "pooled", platform: "openai", type: "api_key",
    }).returning();
    expect(row!.userId).toBeNull();
    expect(row!.teamId).toBeNull();
  });
});
